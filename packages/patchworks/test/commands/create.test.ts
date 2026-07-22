import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { version as packageVersion } from "../../package.json";
import {
  buildPatchworksWorkflow,
  createPatchworksCommitEnv,
  createRepository,
  inferRepositoryName,
  validateRepository,
} from "../../src/create/index";

async function run(
  executable: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(
        new Error(
          `${executable} ${args.join(" ")} failed with ${code}: ${stderr}`,
        ),
      );
    });
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  return await run("git", args, cwd);
}

async function initializeRepository(repository: string): Promise<void> {
  await git(["init", "--initial-branch=main", repository], path.dirname(repository));
  await git(["config", "user.name", "Test User"], repository);
  await git(["config", "user.email", "test@example.com"], repository);
  await git(["config", "commit.gpgsign", "false"], repository);
  await git(["config", "core.hooksPath", "/dev/null"], repository);
}

async function commitAll(repository: string, message = "template"): Promise<void> {
  await git(["add", "--all"], repository);
  await git(["commit", "-m", message], repository);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isolatedLocalGitEnvironment(configPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_CONFIG_") ||
      key.startsWith("GIT_AUTHOR_") ||
      key.startsWith("GIT_COMMITTER_")
    ) {
      delete env[key];
    }
  }
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_ACTOR;
  delete env.GITHUB_ACTOR_ID;
  env.HOME = path.dirname(configPath);
  env.XDG_CONFIG_HOME = path.dirname(configPath);
  return env;
}

describe("createPatchworksCommitEnv", () => {
  it("removes Git overrides and uses the verified GitHub actor identity", async () => {
    const commitEnv = await createPatchworksCommitEnv(process.cwd(), {
      EDITOR: "code",
      GIT_ASKPASS: "/tmp/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      GIT_CONFIG_VALUE_0: "less",
      GIT_DIR: "/tmp/other-repository",
      GIT_EDITOR: "vim",
      GIT_EXTERNAL_DIFF: "diff-tool",
      GIT_INDEX_FILE: "/tmp/index",
      GIT_PAGER: "cat",
      GIT_SEQUENCE_EDITOR: "vim",
      GIT_SSH_COMMAND: "ssh -i key",
      GITHUB_ACTIONS: "true",
      GITHUB_ACTOR: "octocat",
      GITHUB_ACTOR_ID: "1234567",
      GITHUB_TOKEN: "token",
      HOME: "/Users/test",
      PAGER: "less",
      PATH: "/usr/bin",
      PREFIX: "/tmp/prefix",
      SSH_ASKPASS: "/tmp/ssh-askpass",
    });

    expect(Object.keys(commitEnv).filter((key) => key.startsWith("GIT_"))).toEqual([
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
    ]);
    expect(commitEnv).not.toHaveProperty("EDITOR");
    expect(commitEnv).not.toHaveProperty("PAGER");
    expect(commitEnv).not.toHaveProperty("PREFIX");
    expect(commitEnv).not.toHaveProperty("SSH_ASKPASS");
    expect(commitEnv.PATH).toBe("/usr/bin");
    expect(commitEnv.HOME).toBe("/Users/test");
    expect(commitEnv.GITHUB_TOKEN).toBe("token");
    expect(commitEnv.GIT_AUTHOR_NAME).toBe("octocat");
    expect(commitEnv.GIT_AUTHOR_EMAIL).toBe(
      "1234567+octocat@users.noreply.github.com",
    );
    expect(commitEnv.GIT_COMMITTER_NAME).toBe("octocat");
    expect(commitEnv.GIT_COMMITTER_EMAIL).toBe(
      "1234567+octocat@users.noreply.github.com",
    );
  });

  it("uses the username noreply form only when GitHub omits the actor ID", async () => {
    const commitEnv = await createPatchworksCommitEnv(process.cwd(), {
      GITHUB_ACTIONS: "true",
      GITHUB_ACTOR: "github-actions[bot]",
    });

    expect(commitEnv.GIT_AUTHOR_EMAIL).toBe(
      "github-actions[bot]@users.noreply.github.com",
    );
  });

  it("rejects missing actors and malformed actor IDs in GitHub Actions", async () => {
    await expect(
      createPatchworksCommitEnv(process.cwd(), { GITHUB_ACTIONS: "true" }),
    ).rejects.toThrow("GITHUB_ACTOR is missing or invalid");
    await expect(
      createPatchworksCommitEnv(process.cwd(), {
        GITHUB_ACTIONS: "true",
        GITHUB_ACTOR: "octocat",
        GITHUB_ACTOR_ID: "not-a-number",
      }),
    ).rejects.toThrow("GITHUB_ACTOR_ID must be numeric");
    await expect(
      createPatchworksCommitEnv(process.cwd(), {
        GITHUB_ACTIONS: "true",
        GITHUB_ACTOR: "octocat",
        GITHUB_ACTOR_ID: "",
      }),
    ).rejects.toThrow("GITHUB_ACTOR_ID must be numeric");
  });

  it("preserves configured local Git identity and fails clearly when absent", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "patchworks-create-identity-test-"),
    );
    try {
      const configuredPath = path.join(directory, ".gitconfig");
      await writeFile(
        configuredPath,
        "[user]\n\tname = Local Creator\n\temail = creator@example.com\n",
      );
      const configured = await createPatchworksCommitEnv(
        directory,
        isolatedLocalGitEnvironment(configuredPath),
      );
      expect(configured.GIT_AUTHOR_NAME).toBe("Local Creator");
      expect(configured.GIT_AUTHOR_EMAIL).toBe("creator@example.com");

      await writeFile(configuredPath, "");
      await expect(
        createPatchworksCommitEnv(
          directory,
          isolatedLocalGitEnvironment(configuredPath),
        ),
      ).rejects.toThrow("Git user identity is not configured");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prefers repository-local identity from the invocation directory", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "patchworks-create-local-identity-test-"),
    );
    try {
      const configPath = path.join(directory, ".gitconfig");
      await writeFile(
        configPath,
        "[user]\n\tname = Global Creator\n\temail = global@example.com\n",
      );
      const repository = path.join(directory, "repository");
      await initializeRepository(repository);
      await git(["config", "user.name", "Repository Creator"], repository);
      await git(
        ["config", "user.email", "repository@example.com"],
        repository,
      );

      const commitEnv = await createPatchworksCommitEnv(
        repository,
        isolatedLocalGitEnvironment(configPath),
      );
      expect(commitEnv.GIT_AUTHOR_NAME).toBe("Repository Creator");
      expect(commitEnv.GIT_AUTHOR_EMAIL).toBe("repository@example.com");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("ignores Git environment overrides and rejects unsafe identities", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "patchworks-create-identity-safety-test-"),
    );
    try {
      const configPath = path.join(directory, ".gitconfig");
      await writeFile(
        configPath,
        "[user]\n\tname = Safe Creator\n\temail = safe@example.com\n",
      );
      const env = isolatedLocalGitEnvironment(configPath);
      env.GIT_CONFIG_COUNT = "2";
      env.GIT_CONFIG_KEY_0 = "user.name";
      env.GIT_CONFIG_VALUE_0 = "Spoofed Creator";
      env.GIT_CONFIG_KEY_1 = "user.email";
      env.GIT_CONFIG_VALUE_1 = "spoofed@example.com";

      const commitEnv = await createPatchworksCommitEnv(directory, env);
      expect(commitEnv.GIT_AUTHOR_NAME).toBe("Safe Creator");
      expect(commitEnv.GIT_AUTHOR_EMAIL).toBe("safe@example.com");

      await writeFile(
        configPath,
        "[user]\n\tname = Unsafe <Creator>\n\temail = safe@example.com\n",
      );
      await expect(
        createPatchworksCommitEnv(directory, env),
      ).rejects.toThrow("Git user.name contains characters");

      await writeFile(
        configPath,
        '[user]\n\tname = "Unsafe\\nCreator"\n\temail = safe@example.com\n',
      );
      await expect(
        createPatchworksCommitEnv(directory, env),
      ).rejects.toThrow("Git user.name contains characters");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("repository input validation", () => {
  it("infers names from HTTPS, SSH, and local repositories", () => {
    expect(inferRepositoryName("https://github.com/org/template.git")).toBe(
      "template",
    );
    expect(inferRepositoryName("git@github.com:org/template.git")).toBe(
      "template",
    );
    expect(inferRepositoryName("/tmp/template.git/")).toBe("template");
  });

  it("rejects option-like repositories and embedded credentials", () => {
    expect(() => validateRepository("--upload-pack=malicious")).toThrow(
      "Invalid template repository",
    );
    expect(() =>
      validateRepository("https://token@github.com/org/template.git"),
    ).toThrow("must not contain embedded credentials");
    expect(() =>
      validateRepository("https://github.com/org/template.git?token=secret"),
    ).toThrow("must not contain a query string or fragment");
  });

  it("rejects empty values and URLs without a repository name", () => {
    expect(() => validateRepository(" ")).toThrow("must be a non-empty");
    expect(() => inferRepositoryName("https://github.com/")).toThrow(
      "Unable to determine a destination",
    );
    expect(() => validateRepository("https://[")).toThrow(
      "Invalid template repository URL",
    );
    expect(() =>
      validateRepository("ssh://git:secret@github.com/org/template.git"),
    ).toThrow("must not contain embedded credentials");
  });
});

describe("buildPatchworksWorkflow", () => {
  it("pins an exact action and documents when a custom token is needed", () => {
    const workflow = buildPatchworksWorkflow("1.2.3");

    expect(workflow).toContain("group: patchworks-${{ github.repository }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("uses: ludicroushq/patchworks@v1.2.3");
    expect(workflow).toContain(
      "token: ${{ secrets.PATCHWORKS_TOKEN }}",
    );
    expect(workflow).toContain("Workflows write access");
    expect(workflow).toContain("private and cross-repository");
    expect(workflow).toContain("trigger normal CI");
  });
});

describe("createRepository", () => {
  let temporaryRoot: string;
  let createEnv: NodeJS.ProcessEnv;

  function create(
    options: Omit<Parameters<typeof createRepository>[0], "env">,
  ) {
    return createRepository({ ...options, env: createEnv });
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "patchworks-create-test-"));
    const configPath = path.join(temporaryRoot, ".gitconfig");
    await writeFile(
      configPath,
      "[user]\n\tname = Local Creator\n\temail = creator@example.com\n",
    );
    createEnv = isolatedLocalGitEnvironment(configPath);
  });

  afterEach(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  it("creates parentless history from the exact template tree", async () => {
    const dependency = path.join(temporaryRoot, "dependency");
    await initializeRepository(dependency);
    await writeFile(path.join(dependency, "dependency.txt"), "dependency\n");
    await commitAll(dependency);
    const dependencyCommit = await git(["rev-parse", "HEAD"], dependency);

    const template = path.join(temporaryRoot, "template");
    await initializeRepository(template);
    await writeFile(path.join(template, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(template, "ignored.txt"), "tracked anyway\n");
    await writeFile(path.join(template, "binary.dat"), new Uint8Array([0, 1, 2, 255]));
    await writeFile(path.join(template, "run.sh"), "#!/bin/sh\necho ok\n");
    await chmod(path.join(template, "run.sh"), 0o755);
    await mkdir(path.join(template, ".github", "workflows"), {
      recursive: true,
    });
    await writeFile(
      path.join(template, ".github", "workflows", "existing.yaml"),
      "name: existing\n",
    );
    await git(
      [
        "add",
        ".gitignore",
        "binary.dat",
        "run.sh",
        ".github/workflows/existing.yaml",
      ],
      template,
    );
    await git(["add", "--force", "ignored.txt"], template);
    await git(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${dependencyCommit},vendor/dependency`,
      ],
      template,
    );
    await git(["commit", "-m", "template tree"], template);

    const templateCommit = await git(["rev-parse", "HEAD"], template);
    const templateTree = await git(["rev-parse", "HEAD^{tree}"], template);
    const templateInput = path.relative(process.cwd(), template);
    const destination = path.join(temporaryRoot, "generated");

    const result = await create({
      destination,
      repoUrl: templateInput,
    });

    expect(result.branch).toBe("main");
    expect(result.templateCommit).toBe(templateCommit);
    const initialCommit = await git(["rev-parse", "HEAD^"], destination);
    expect(initialCommit).toBe(result.initialCommit);
    expect(await git(["rev-list", "--count", "HEAD"], destination)).toBe("2");
    expect(
      (await git(["rev-list", "--parents", "--max-count=1", initialCommit], destination)).split(
        " ",
      ),
    ).toEqual([initialCommit]);
    expect(await git(["rev-parse", `${initialCommit}^{tree}`], destination)).toBe(
      templateTree,
    );
    expect(await git(["show", `${initialCommit}:ignored.txt`], destination)).toBe(
      "tracked anyway",
    );
    expect(await git(["ls-tree", initialCommit, "run.sh"], destination)).toMatch(
      /^100755 blob /,
    );
    expect(
      await git(["ls-tree", initialCommit, "vendor/dependency"], destination),
    ).toMatch(new RegExp(`^160000 commit ${dependencyCommit}`));
    expect([...await readFile(path.join(destination, "binary.dat"))]).toEqual([
      0, 1, 2, 255,
    ]);

    const config = JSON.parse(
      await readFile(path.join(destination, ".patchworks.json"), "utf8"),
    ) as {
      commit: string;
      template: { branch: string; repository: string };
    };
    expect(config).toMatchObject({
      commit: templateCommit,
      template: { branch: "main", repository: template },
    });
    const generatedWorkflow = await readFile(
      path.join(destination, ".github", "workflows", "patchworks.yaml"),
      "utf8",
    );
    expect(generatedWorkflow).toContain(
      `uses: ludicroushq/patchworks@v${packageVersion}`,
    );
    expect(generatedWorkflow).toContain(
      "token: ${{ secrets.PATCHWORKS_TOKEN }}",
    );
    expect(await git(["remote"], destination)).toBe("");
    expect(await git(["status", "--porcelain"], destination)).toBe("");

    const identities = await git(
      ["log", "-2", "--format=%an <%ae> / %cn <%ce>"],
      destination,
    );
    expect(identities.split("\n")).toEqual([
      "Local Creator <creator@example.com> / Local Creator <creator@example.com>",
      "Local Creator <creator@example.com> / Local Creator <creator@example.com>",
    ]);
  });

  it("rejects a template Patchworks config without leaving a destination", async () => {
    const template = path.join(temporaryRoot, "template");
    await initializeRepository(template);
    await writeFile(path.join(template, ".patchworks.json"), "{}\n");
    await commitAll(template);
    const destination = path.join(temporaryRoot, "generated");

    await expect(
      create({ branch: "main", destination, repoUrl: template }),
    ).rejects.toThrow("already contains '.patchworks.json'");
    expect(await exists(destination)).toBe(false);
    expect(
      (await readdir(temporaryRoot)).some((name) =>
        name.startsWith(".patchworks-create-"),
      ),
    ).toBe(false);
  });

  it("rejects an existing generated workflow without overwriting it", async () => {
    const template = path.join(temporaryRoot, "template");
    await initializeRepository(template);
    const workflow = path.join(
      template,
      ".github",
      "workflows",
      "patchworks.yaml",
    );
    await mkdir(path.dirname(workflow), { recursive: true });
    await writeFile(workflow, "name: template-owned\n");
    await commitAll(template);
    const destination = path.join(temporaryRoot, "generated");

    await expect(
      create({ branch: "main", destination, repoUrl: template }),
    ).rejects.toThrow("already contains '.github/workflows/patchworks.yaml'");
    expect(await exists(destination)).toBe(false);
  });

  it("rejects workflow ancestor symlinks without writing outside the clone", async () => {
    const outside = path.join(temporaryRoot, "outside");
    await mkdir(outside);
    const template = path.join(temporaryRoot, "template");
    await initializeRepository(template);
    await symlink(outside, path.join(template, ".github"));
    await commitAll(template);
    const destination = path.join(temporaryRoot, "generated");

    await expect(
      create({ branch: "main", destination, repoUrl: template }),
    ).rejects.toThrow("'.github' is not a directory");
    expect(await exists(path.join(outside, "workflows", "patchworks.yaml"))).toBe(
      false,
    );
    expect(await exists(destination)).toBe(false);
  });

  it("preserves an existing empty destination when cloning fails", async () => {
    const destination = path.join(temporaryRoot, "generated");
    await mkdir(destination);

    await expect(
      create({
        branch: "main",
        destination,
        repoUrl: path.join(temporaryRoot, "missing-template"),
      }),
    ).rejects.toThrow("git clone");
    expect(await exists(destination)).toBe(true);
    expect(await readdir(destination)).toEqual([]);
    expect(
      (await readdir(temporaryRoot)).some((name) =>
        name.startsWith(".patchworks-create-"),
      ),
    ).toBe(false);
  });

  it("atomically replaces an existing empty destination on success", async () => {
    const template = path.join(temporaryRoot, "template");
    await initializeRepository(template);
    await writeFile(path.join(template, "README.md"), "template\n");
    await commitAll(template);
    const destination = path.join(temporaryRoot, "generated");
    await mkdir(destination);
    const originalWorkingDirectory = process.cwd();

    await create({
      branch: "main",
      destination,
      repoUrl: pathToFileURL(template).href,
    });

    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe(
      "template\n",
    );
    expect(process.cwd()).toBe(originalWorkingDirectory);
    expect(await git(["rev-list", "--count", "HEAD"], destination)).toBe("2");
  });

  it("rejects invalid branches before creating temporary files", async () => {
    const destination = path.join(temporaryRoot, "generated");

    await expect(
      create({
        branch: "../main",
        destination,
        repoUrl: path.join(temporaryRoot, "template"),
      }),
    ).rejects.toThrow("Invalid template branch");
    await expect(
      create({
        branch: "HEAD",
        destination,
        repoUrl: path.join(temporaryRoot, "template"),
      }),
    ).rejects.toThrow("Invalid template branch");
    expect(await exists(destination)).toBe(false);
    expect(
      (await readdir(temporaryRoot)).some((name) =>
        name.startsWith(".patchworks-create-"),
      ),
    ).toBe(false);
  });

  it("fails before cloning when local Git identity is missing", async () => {
    const template = path.join(temporaryRoot, "template");
    await initializeRepository(template);
    await writeFile(path.join(template, "README.md"), "template\n");
    await commitAll(template);
    const destination = path.join(temporaryRoot, "generated");
    const identityRoot = path.join(temporaryRoot, "identity-missing");
    await mkdir(identityRoot);
    const emptyConfig = path.join(identityRoot, ".gitconfig");
    await writeFile(emptyConfig, "");

    await expect(
      createRepository({
        branch: "main",
        destination,
        env: isolatedLocalGitEnvironment(emptyConfig),
        repoUrl: template,
      }),
    ).rejects.toThrow("Git user identity is not configured");
    expect(await exists(destination)).toBe(false);
    expect(
      (await readdir(temporaryRoot)).some((name) =>
        name.startsWith(".patchworks-create-"),
      ),
    ).toBe(false);
  });

  it("reports default-branch fallback and still cleans up a failed clone", async () => {
    const progress: string[] = [];
    const destination = path.join(temporaryRoot, "generated");

    await expect(
      create({
        destination,
        onProgress: (message) => progress.push(message),
        repoUrl: path.join(temporaryRoot, "missing-template"),
      }),
    ).rejects.toThrow("git clone");
    expect(progress).toContain(
      "Could not detect the default branch; falling back to main.",
    );
    expect(await exists(destination)).toBe(false);
    expect(
      (await readdir(temporaryRoot)).some((name) =>
        name.startsWith(".patchworks-create-"),
      ),
    ).toBe(false);
  });

  it("rejects unsafe or unusable destination paths before cloning", async () => {
    const nonEmptyDestination = path.join(temporaryRoot, "non-empty");
    await mkdir(nonEmptyDestination);
    await writeFile(path.join(nonEmptyDestination, "keep.txt"), "keep\n");

    await expect(
      create({
        branch: "main",
        destination: nonEmptyDestination,
        repoUrl: "template",
      }),
    ).rejects.toThrow("already exists and is not empty");
    await expect(
      create({
        branch: "main",
        destination: path.join(temporaryRoot, "missing-parent", "generated"),
        repoUrl: "template",
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      create({
        branch: "main",
        destination: path.parse(temporaryRoot).root,
        repoUrl: "template",
      }),
    ).rejects.toThrow("filesystem root");
    await expect(
      create({
        branch: "main",
        destination: "",
        repoUrl: "template",
      }),
    ).rejects.toThrow("non-empty directory path");

    const fileDestination = path.join(temporaryRoot, "destination-file");
    await writeFile(fileDestination, "do not replace\n");
    await expect(
      create({
        branch: "main",
        destination: fileDestination,
        repoUrl: "template",
      }),
    ).rejects.toThrow("already exists");
    expect(await readFile(path.join(nonEmptyDestination, "keep.txt"), "utf8")).toBe(
      "keep\n",
    );
    expect(await readFile(fileDestination, "utf8")).toBe("do not replace\n");
  });
});
