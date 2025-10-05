import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPatchworksUpdate, setWorkspaceForTesting } from "../index";

type SpawnResult = {
  stdout: string;
  stderr: string;
};

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function git(args: string[], cwd: string) {
  return run("git", args, cwd);
}

describe("patchworks integration", () => {
  const originalWorkspace = process.cwd();
  const originalEnv = { ...process.env };
  let tempRoot: string;
  let templateDir: string;
  let projectDir: string;
  let originDir: string;
  let templateCommitV1: string;
  let templateCommitV2: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "patchworks-int-"));
    templateDir = path.join(tempRoot, "template");
    projectDir = path.join(tempRoot, "project");
    originDir = path.join(tempRoot, "origin.git");

    await git(["init", "--initial-branch=main", templateDir], tempRoot);

    await git(["config", "user.name", "Test"], templateDir);
    await git(["config", "user.email", "test@example.com"], templateDir);

    await writeFile(path.join(templateDir, "hello.txt"), "v1\n", "utf8");
    await git(["add", "hello.txt"], templateDir);
    await git(["commit", "-m", "template v1"], templateDir);
    templateCommitV1 = (await git(["rev-parse", "HEAD"], templateDir)).stdout;

    await writeFile(path.join(templateDir, "hello.txt"), "v2\n", "utf8");
    await git(["commit", "-am", "template v2"], templateDir);
    templateCommitV2 = (await git(["rev-parse", "HEAD"], templateDir)).stdout;

    await git(["init", "--bare", originDir], tempRoot);

    await git(["clone", templateDir, projectDir], tempRoot);
    await git(["config", "user.name", "Test"], projectDir);
    await git(["config", "user.email", "test@example.com"], projectDir);
    await git(["checkout", templateCommitV1], projectDir);
    await git(["checkout", "-B", "main"], projectDir);
    await git(["remote", "remove", "origin"], projectDir);
    await git(["remote", "add", "origin", originDir], projectDir);

    const patchworksConfig = {
      version: "0.0.0-test",
      template: {
        repository: templateDir,
        branch: "main",
      },
      commit: templateCommitV1,
    } satisfies Record<string, unknown>;

    await writeFile(
      path.join(projectDir, ".patchworks.json"),
      `${JSON.stringify(patchworksConfig, null, 2)}\n`,
      "utf8",
    );
    await git(["add", ".patchworks.json"], projectDir);
    await git(["commit", "-m", "add patchworks config"], projectDir);
    await git(["push", "-u", "origin", "main"], projectDir);

    process.env.GITHUB_WORKSPACE = projectDir;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    process.env.GITHUB_TOKEN = "test-token";
    process.env.PATCHWORKS_BRANCH_NAME = "patchworks/update";

    setWorkspaceForTesting(projectDir);
  });

  afterAll(async () => {
    setWorkspaceForTesting(originalWorkspace);
    process.env = { ...originalEnv };
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await git(["checkout", "main"], projectDir).catch(() => {});
  });

  it("updates repository to next template commit", async () => {
    let prBody = "";
    let prTitle = "";

    await runPatchworksUpdate({
      checkExistingPullRequest: async () => false,
      createPullRequest: async (
        _token,
        _owner,
        _repo,
        title,
        _head,
        _base,
        body,
      ) => {
        prTitle = title;
        prBody = body;
      },
    });

    const configContents = JSON.parse(
      (await run("cat", [".patchworks.json"], projectDir)).stdout,
    ) as { commit: string };
    expect(configContents.commit).toBe(templateCommitV2);

    const updateLog = (
      await git(
        ["log", "-1", "--pretty=format:%s", "patchworks/update"],
        projectDir,
      )
    ).stdout;
    expect(updateLog).toContain("Patchworks: sync");

    const workingFile = (await run("cat", ["hello.txt"], projectDir)).stdout;
    expect(workingFile).toBe("v2");

    expect(prTitle).toContain(templateCommitV2.substring(0, 7));
    expect(prBody).toContain("## Summary");
    expect(prBody).toContain("## Rejects");

    const remoteRefs = (
      await git(
        ["ls-remote", originDir, "refs/heads/patchworks/update"],
        tempRoot,
      )
    ).stdout;
    expect(remoteRefs).not.toBe("");
  });
});
