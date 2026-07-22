import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPatchworksUpdate } from "../../src/update/index.js";
import {
  commitAll,
  createBasicRepositories,
  git,
  initializeGitRepository,
  type TestRepository,
} from "./helpers.js";

const roots = new Set<string>();

async function fixture(): Promise<TestRepository> {
  const value = await createBasicRepositories();
  roots.add(value.root);
  return value;
}

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("Patchworks update integration", () => {
  it("applies exactly one template commit and leaves no persistent remote", async () => {
    const repositories = await fixture();
    await writeFile(
      path.join(repositories.template, "hello.txt"),
      "version two\n",
      "utf8",
    );
    const secondCommit = await commitAll(
      repositories.template,
      "template: version two",
    );

    const remotesBefore = await git(repositories.project, "remote");
    const result = await runPatchworksUpdate({
      workspace: repositories.project,
    });

    expect(await readFile(path.join(repositories.project, "hello.txt"), "utf8"))
      .toBe("version two\n");
    expect(result).toMatchObject({
      status: "updated",
      hasChanges: true,
      hadConflicts: false,
      rebased: false,
      currentCommit: repositories.firstCommit,
      nextCommit: secondCommit,
    });
    expect(result.changedFiles).toEqual([".patchworks.json", "hello.txt"]);
    expect(result.prBody).toContain("template: version two");
    expect(await git(repositories.project, "remote")).toBe(remotesBefore);
    expect(
      await git(
        repositories.project,
        "for-each-ref",
        "--format=%(refname)",
        "refs/patchworks",
      ),
    ).toBe("");
  });

  it("walks merge-heavy templates on the deterministic first-parent path", async () => {
    const repositories = await fixture();
    await git(repositories.template, "checkout", "-b", "feature");
    await writeFile(
      path.join(repositories.template, "feature.txt"),
      "feature\n",
      "utf8",
    );
    await commitAll(repositories.template, "feature commit");
    await git(repositories.template, "checkout", "main");
    await writeFile(
      path.join(repositories.template, "main.txt"),
      "mainline\n",
      "utf8",
    );
    const mainlineCommit = await commitAll(
      repositories.template,
      "mainline commit",
    );
    await git(
      repositories.template,
      "merge",
      "--no-ff",
      "feature",
      "-m",
      "merge feature",
    );

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.nextCommit).toBe(mainlineCommit);
    expect(result.changedFiles).toContain("main.txt");
    expect(result.changedFiles).not.toContain("feature.txt");
  });

  it("advances tracking without rejects when the template change is already present", async () => {
    const repositories = await fixture();
    await writeFile(
      path.join(repositories.template, "hello.txt"),
      "version two\n",
      "utf8",
    );
    const secondCommit = await commitAll(repositories.template, "version two");
    await writeFile(
      path.join(repositories.project, "hello.txt"),
      "version two\n",
      "utf8",
    );
    await commitAll(repositories.project, "Implement change independently");

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.nextCommit).toBe(secondCommit);
    expect(result.rejectFiles).toEqual([]);
    expect(result.changedFiles).toEqual([".patchworks.json"]);
    expect(result.warnings[0]).toContain("already present");
  });

  it("preserves exact rejects and the full patch when downstream code conflicts", async () => {
    const repositories = await fixture();
    await writeFile(
      path.join(repositories.template, "hello.txt"),
      "upstream edit\n",
      "utf8",
    );
    const secondCommit = await commitAll(repositories.template, "upstream edit");
    await writeFile(
      path.join(repositories.project, "hello.txt"),
      "downstream edit\n",
      "utf8",
    );
    await commitAll(repositories.project, "downstream edit");

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.status).toBe("conflicts");
    expect(result.hadConflicts).toBe(true);
    expect(result.rejectFiles).toContain(
      `.patchworks-rejects/${secondCommit}/files/hello.txt.rej`,
    );
    expect(result.rejectFiles).toContain(
      `.patchworks-rejects/${secondCommit}/template.patch`,
    );
    expect(
      await readFile(
        path.join(
          repositories.project,
          ".patchworks-rejects",
          secondCommit,
          "template.patch",
        ),
        "utf8",
      ),
    ).toContain("upstream edit");
    const config = JSON.parse(
      await readFile(
        path.join(repositories.project, ".patchworks.json"),
        "utf8",
      ),
    ) as { commit: string };
    expect(config.commit).toBe(secondCommit);
  });

  it("moves ignored reject files into a visible conflict directory", async () => {
    const repositories = await fixture();
    await writeFile(path.join(repositories.template, ".gitignore"), ".env*\n");
    await writeFile(
      path.join(repositories.template, ".env.example"),
      "TEMPLATE=one\n",
    );
    await git(repositories.template, "add", ".gitignore");
    await git(repositories.template, "add", "--force", ".env.example");
    await git(repositories.template, "commit", "-m", "add env example");
    await runPatchworksUpdate({ workspace: repositories.project });
    await commitAll(repositories.project, "Apply env setup");

    await writeFile(
      path.join(repositories.template, ".env.example"),
      "TEMPLATE=upstream\n",
    );
    const nextCommit = await commitAll(repositories.template, "change env example");
    await writeFile(
      path.join(repositories.project, ".env.example"),
      "TEMPLATE=downstream\n",
    );
    await commitAll(repositories.project, "Customize env example");

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    const centralizedReject = `.patchworks-rejects/${nextCommit}/files/.env.example.rej`;
    expect(result.status).toBe("conflicts");
    expect(result.rejectFiles).toContain(centralizedReject);
    await expect(
      readFile(path.join(repositories.project, ".env.example.rej"), "utf8"),
    ).rejects.toThrow("ENOENT");
    expect(
      await readFile(path.join(repositories.project, centralizedReject), "utf8"),
    ).toContain("TEMPLATE=upstream");
    expect(await git(repositories.project, "diff", "--name-only")).toContain(
      centralizedReject,
    );
  });

  it("preserves renames, executable modes, binary data, and tracked ignored files", async () => {
    const repositories = await fixture();
    await writeFile(path.join(repositories.template, ".gitignore"), "*.cache\n");
    await writeFile(path.join(repositories.template, "old-name.txt"), "rename\n");
    await writeFile(path.join(repositories.template, "tracked.cache"), "one\n");
    await writeFile(path.join(repositories.template, "script.sh"), "#!/bin/sh\n");
    await git(repositories.template, "add", "-f", "tracked.cache");
    await commitAll(repositories.template, "add fixture files");

    // Advance the child through the setup commit before testing the rich diff.
    await runPatchworksUpdate({ workspace: repositories.project });
    await commitAll(repositories.project, "Apply fixture setup");

    await git(repositories.template, "mv", "old-name.txt", "new-name.txt");
    await writeFile(path.join(repositories.template, "tracked.cache"), "two\n");
    await writeFile(
      path.join(repositories.template, "binary.dat"),
      Buffer.from([0, 1, 2, 255, 10]),
    );
    await chmod(path.join(repositories.template, "script.sh"), 0o755);
    await commitAll(repositories.template, "rich git changes");

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.status).toBe("updated");
    expect(await git(repositories.project, "diff", "--cached", "--name-only"))
      .toBe("");
    expect(result.changedFiles).toEqual(
      expect.arrayContaining([
        "binary.dat",
        "new-name.txt",
        "script.sh",
        "tracked.cache",
      ]),
    );
    expect(await readFile(path.join(repositories.project, "binary.dat"))).toEqual(
      Buffer.from([0, 1, 2, 255, 10]),
    );
    expect((await stat(path.join(repositories.project, "script.sh"))).mode & 0o111)
      .toBe(0o111);
    expect(
      await readFile(path.join(repositories.project, "tracked.cache"), "utf8"),
    ).toBe("two\n");
    await expect(
      readFile(path.join(repositories.project, "old-name.txt"), "utf8"),
    ).rejects.toThrow("ENOENT");
  });

  it("preserves Gitlink pointer updates in the index for explicit staged review", async () => {
    const repositories = await fixture();
    const dependency = path.join(repositories.root, "dependency");
    await initializeGitRepository(dependency);
    await writeFile(path.join(dependency, "dependency.txt"), "one\n");
    const dependencyV1 = await commitAll(dependency, "dependency one");
    await writeFile(path.join(dependency, "dependency.txt"), "two\n");
    const dependencyV2 = await commitAll(dependency, "dependency two");

    await git(
      repositories.template,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${dependencyV1},vendor/dependency`,
    );
    await git(repositories.template, "commit", "-m", "add dependency pointer");
    await runPatchworksUpdate({ workspace: repositories.project });
    await commitAll(repositories.project, "Apply dependency setup");

    await git(
      repositories.template,
      "update-index",
      "--cacheinfo",
      `160000,${dependencyV2},vendor/dependency`,
    );
    await git(repositories.template, "commit", "-m", "update dependency pointer");

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.status).toBe("updated");
    expect(result.stagedFiles).toEqual(["vendor/dependency"]);
    expect(result.warnings.join("\n")).toContain("git diff --cached");
    expect(
      await git(
        repositories.project,
        "diff",
        "--cached",
        "--raw",
        "HEAD",
        "--",
        "vendor/dependency",
      ),
    ).toContain(dependencyV2.slice(0, 7));
    expect(await git(repositories.project, "diff", "--name-only")).toBe(
      ".patchworks.json",
    );
  });

  it("keeps child tracking metadata and reports workflow changes", async () => {
    const repositories = await fixture();
    await writeFile(
      path.join(repositories.template, ".patchworks.json"),
      '{"template":"must not replace child config"}\n',
    );
    await writeFile(
      path.join(repositories.template, ".github-workflow-placeholder"),
      "setup\n",
    );
    await commitAll(repositories.template, "template metadata setup");
    await runPatchworksUpdate({ workspace: repositories.project });
    await commitAll(repositories.project, "Apply metadata setup");

    const workflowDirectory = path.join(
      repositories.template,
      ".github",
      "workflows",
    );
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(workflowDirectory, { recursive: true }),
    );
    await writeFile(path.join(workflowDirectory, "ci.yml"), "name: CI\n");
    await writeFile(
      path.join(repositories.template, ".patchworks.json"),
      '{"changed":"upstream"}\n',
    );
    await commitAll(repositories.template, "add workflow");

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.workflowChanges).toBe(true);
    const config = JSON.parse(
      await readFile(
        path.join(repositories.project, ".patchworks.json"),
        "utf8",
      ),
    ) as { template: { repository: string } };
    expect(config.template.repository).toBe(repositories.template);
    expect(result.changedFiles).not.toContain(".patchworks.json.rej");
  });
});
