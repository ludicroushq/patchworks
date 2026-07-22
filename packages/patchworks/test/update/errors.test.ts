import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePatchworksConfig } from "../../src/update/config.js";
import { runPatchworksUpdate } from "../../src/update/index.js";
import {
  commitAll,
  createBasicRepositories,
  git,
  type TestRepository,
  writePatchworksConfig,
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

describe("configuration validation", () => {
  it("rejects malformed and non-object JSON", () => {
    expect(() => parsePatchworksConfig("{oops")).toThrow("valid JSON");
    expect(() => parsePatchworksConfig("[]")).toThrow("JSON object");
  });

  it("requires a full object ID and repository", () => {
    expect(() =>
      parsePatchworksConfig(
        JSON.stringify({ template: { repository: "owner/repo" } }),
      ),
    ).toThrow("full 40- or 64-character Git object ID");
    expect(() =>
      parsePatchworksConfig(
        JSON.stringify({ commit: "a".repeat(40), template: {} }),
      ),
    ).toThrow("Missing template.repository");
  });

  it("rejects embedded credentials and invalid optional values", () => {
    expect(() =>
      parsePatchworksConfig(
        JSON.stringify({
          commit: "a".repeat(40),
          template: {
            repository: "https://token@example.com/owner/repo.git",
          },
        }),
      ),
    ).toThrow("must not contain credentials");
    expect(() =>
      parsePatchworksConfig(
        JSON.stringify({
          commit: "a".repeat(40),
          template: { repository: "owner/repo", branch: 42 },
        }),
      ),
    ).toThrow("template.branch");
    expect(() =>
      parsePatchworksConfig(
        JSON.stringify({
          commit: "a".repeat(40),
          version: 1,
          template: { repository: "owner/repo" },
        }),
      ),
    ).toThrow("version must be a string");
  });

  it("reports a missing config from a valid Git repository", async () => {
    const repositories = await fixture();
    await rm(path.join(repositories.project, ".patchworks.json"));
    await git(repositories.project, "add", "-u");
    await git(repositories.project, "commit", "-m", "remove config");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow(".patchworks.json not found");
  });

  it("does not follow a symlinked config outside the repository", async () => {
    const repositories = await fixture();
    const outside = path.join(repositories.root, "outside.json");
    await writeFile(
      outside,
      JSON.stringify({
        commit: repositories.firstCommit,
        template: { repository: repositories.template, branch: "main" },
      }),
    );
    await rm(path.join(repositories.project, ".patchworks.json"));
    await symlink("../outside.json", path.join(repositories.project, ".patchworks.json"));
    await commitAll(repositories.project, "replace config with symlink");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("symbolic links are not allowed");
  });
});

describe("update preconditions", () => {
  it("rejects dirty worktrees with a useful file list", async () => {
    const repositories = await fixture();
    await writeFile(path.join(repositories.project, "dirty.txt"), "dirty\n");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("dirty.txt");
  });

  it("rejects invalid branch names before fetching", async () => {
    const repositories = await fixture();
    await writePatchworksConfig(
      repositories.project,
      repositories.template,
      repositories.firstCommit,
      "-upload-pack=oops",
    );
    await commitAll(repositories.project, "invalid branch fixture");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("Invalid template branch");
  });

  it("returns a fully populated up-to-date result", async () => {
    const repositories = await fixture();
    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result).toEqual({
      status: "up-to-date",
      hasChanges: false,
      hadConflicts: false,
      rebased: false,
      workflowChanges: false,
      changedFiles: [],
      stagedFiles: [],
      commitMessage: "",
      prTitle: "",
      prBody: "",
      rejectFiles: [],
      currentCommit: repositories.firstCommit,
      nextCommit: repositories.firstCommit,
      warnings: [],
    });
  });

  it("prevents concurrent runs with a repository-local lock", async () => {
    const repositories = await fixture();
    await writeFile(
      path.join(repositories.project, ".git", "patchworks.lock"),
      `${JSON.stringify({ token: "other", pid: 123, startedAt: new Date().toISOString() })}\n`,
    );

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("Another Patchworks update appears to be running");
  });

  it("recovers a stale lock and resolves the repository root from a subdirectory", async () => {
    const repositories = await fixture();
    const lock = path.join(repositories.project, ".git", "patchworks.lock");
    await writeFile(lock, "stale\n");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await utimes(lock, staleTime, staleTime);
    const subdirectory = path.join(repositories.project, "nested");
    await mkdir(subdirectory);

    const result = await runPatchworksUpdate({ workspace: subdirectory });
    expect(result.status).toBe("up-to-date");
    await expect(access(lock)).rejects.toThrow("ENOENT");
  });

  it("reports fetch failures without persisting a remote or mutation", async () => {
    const repositories = await fixture();
    await writePatchworksConfig(
      repositories.project,
      path.join(repositories.root, "missing-template"),
      repositories.firstCommit,
    );
    await commitAll(repositories.project, "missing repository fixture");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("Unable to fetch template branch");
    expect(await git(repositories.project, "remote")).toBe("");
    expect(await git(repositories.project, "status", "--porcelain")).toBe("");
  });
});

describe("history and transactional safety", () => {
  it("never overwrites an existing ignored template target", async () => {
    const repositories = await fixture();
    await writeFile(path.join(repositories.project, ".gitignore"), ".env.local\n");
    await commitAll(repositories.project, "Ignore local environment");
    await writeFile(
      path.join(repositories.project, ".env.local"),
      "SECRET=downstream\n",
    );
    await writeFile(
      path.join(repositories.template, ".env.local"),
      "TEMPLATE=value\n",
    );
    await commitAll(repositories.template, "add env local");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("already exists as an ignored or untracked file");
    expect(
      await readFile(path.join(repositories.project, ".env.local"), "utf8"),
    ).toBe("SECRET=downstream\n");
    expect(await git(repositories.project, "status", "--porcelain")).toBe("");
  });

  it("requires explicit rebase for rewritten first-parent history", async () => {
    const repositories = await fixture();
    // Retain the old template object in the child so history topology, rather
    // than object availability, is what Patchworks evaluates.
    await git(
      repositories.project,
      "fetch",
      "--no-tags",
      repositories.template,
      repositories.firstCommit,
    );
    await git(repositories.template, "checkout", "--orphan", "rewritten");
    await writeFile(
      path.join(repositories.template, "hello.txt"),
      "rewritten history\n",
    );
    await commitAll(repositories.template, "rewritten root");
    await git(repositories.template, "branch", "-M", "main");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("not on the first-parent history");

    const result = await runPatchworksUpdate({
      workspace: repositories.project,
      rebase: true,
    });
    expect(result.rebased).toBe(true);
    expect(result.commitMessage).toContain("rebase");
    expect(
      await readFile(path.join(repositories.project, "hello.txt"), "utf8"),
    ).toBe("rewritten history\n");
  });

  it("rolls back every generated file if the reject directory is unsafe", async () => {
    const repositories = await fixture();
    const outside = path.join(repositories.root, "outside");
    await mkdir(outside);
    await symlink(
      "../outside",
      path.join(repositories.project, ".patchworks-rejects"),
    );
    await writeFile(
      path.join(repositories.project, "hello.txt"),
      "downstream edit\n",
    );
    await commitAll(repositories.project, "downstream conflict and unsafe link");
    await writeFile(
      path.join(repositories.template, "hello.txt"),
      "upstream edit\n",
    );
    await commitAll(repositories.template, "upstream conflict");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("symbolic links are not allowed");
    expect(
      await readFile(path.join(repositories.project, "hello.txt"), "utf8"),
    ).toBe("downstream edit\n");
    expect(
      JSON.parse(
        await readFile(
          path.join(repositories.project, ".patchworks.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ commit: repositories.firstCommit });
    expect(await git(repositories.project, "status", "--porcelain")).toBe("");
  });

  it("reports missing pruned commits without mutating the project", async () => {
    const repositories = await fixture();
    await writePatchworksConfig(
      repositories.project,
      repositories.template,
      "f".repeat(40),
    );
    await commitAll(repositories.project, "missing commit fixture");

    await expect(
      runPatchworksUpdate({ workspace: repositories.project }),
    ).rejects.toThrow("is unavailable");
    await expect(
      runPatchworksUpdate({ workspace: repositories.project, rebase: true }),
    ).rejects.toThrow("is unavailable");
    expect(await git(repositories.project, "status", "--porcelain")).toBe("");
  });

  it("advances only child metadata when the template changes its own config", async () => {
    const repositories = await fixture();
    await writeFile(
      path.join(repositories.template, ".patchworks.json"),
      '{"template":"parent-owned"}\n',
    );
    const nextCommit = await commitAll(
      repositories.template,
      "change parent metadata only",
    );

    const result = await runPatchworksUpdate({ workspace: repositories.project });
    expect(result.nextCommit).toBe(nextCommit);
    expect(result.changedFiles).toEqual([".patchworks.json"]);
  });
});
