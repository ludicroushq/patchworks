import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("patchworks error handling", () => {
  const originalWorkspace = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "patchworks-errors-"));
    setWorkspaceForTesting(tempDir);
  });

  afterEach(async () => {
    setWorkspaceForTesting(originalWorkspace);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("config validation", () => {
    it("throws when .patchworks.json is missing", async () => {
      await expect(runPatchworksUpdate()).rejects.toThrow(
        ".patchworks.json not found",
      );
    });

    it("throws when .patchworks.json is invalid JSON", async () => {
      await writeFile(
        path.join(tempDir, ".patchworks.json"),
        "{ invalid json",
        "utf8",
      );

      await expect(runPatchworksUpdate()).rejects.toThrow(
        "Unable to parse .patchworks.json",
      );
    });

    it("throws when commit field is missing", async () => {
      await writeFile(
        path.join(tempDir, ".patchworks.json"),
        JSON.stringify({
          template: {
            repository: "https://github.com/org/repo",
            branch: "main",
          },
        }),
        "utf8",
      );

      await expect(runPatchworksUpdate()).rejects.toThrow(
        "Missing commit in patchworks config",
      );
    });

    it("throws when template.repository is missing", async () => {
      await writeFile(
        path.join(tempDir, ".patchworks.json"),
        JSON.stringify({
          commit: "abc123",
          template: {
            branch: "main",
          },
        }),
        "utf8",
      );

      await expect(runPatchworksUpdate()).rejects.toThrow(
        "Missing template.repository in patchworks config",
      );
    });

    it("throws when commit is not a string", async () => {
      await writeFile(
        path.join(tempDir, ".patchworks.json"),
        JSON.stringify({
          commit: 123,
          template: {
            repository: "https://github.com/org/repo",
            branch: "main",
          },
        }),
        "utf8",
      );

      await expect(runPatchworksUpdate()).rejects.toThrow(
        "Missing commit in patchworks config",
      );
    });
  });

  describe("dirty working tree", () => {
    it("throws when working tree has uncommitted changes", async () => {
      await git(["init", "--initial-branch=main"], tempDir);
      await git(["config", "user.name", "Test"], tempDir);
      await git(["config", "user.email", "test@example.com"], tempDir);

      await writeFile(path.join(tempDir, "file.txt"), "content", "utf8");
      await git(["add", "file.txt"], tempDir);
      await git(["commit", "-m", "initial"], tempDir);

      const commit = (await git(["rev-parse", "HEAD"], tempDir)).stdout;

      await writeFile(
        path.join(tempDir, ".patchworks.json"),
        JSON.stringify({
          commit,
          template: {
            repository: "https://github.com/org/repo",
            branch: "main",
          },
        }),
        "utf8",
      );

      // Create a dirty file
      await writeFile(path.join(tempDir, "dirty.txt"), "uncommitted", "utf8");

      const error = await runPatchworksUpdate().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Working tree is not clean");
      expect((error as Error).message).toContain("dirty.txt");
    });
  });

  describe("template commit scenarios", () => {
    it("throws when current commit not found in template history", async () => {
      const templateDir = path.join(tempDir, "template");
      await git(["init", "--initial-branch=main", templateDir], tempDir);
      await git(["config", "user.name", "Test"], templateDir);
      await git(["config", "user.email", "test@example.com"], templateDir);
      await writeFile(path.join(templateDir, "file.txt"), "v1", "utf8");
      await git(["add", "file.txt"], templateDir);
      await git(["commit", "-m", "v1"], templateDir);

      const projectDir = path.join(tempDir, "project");
      await git(["init", "--initial-branch=main", projectDir], tempDir);
      await git(["config", "user.name", "Test"], projectDir);
      await git(["config", "user.email", "test@example.com"], projectDir);
      await writeFile(path.join(projectDir, "file.txt"), "content", "utf8");
      await git(["add", "file.txt"], projectDir);
      await git(["commit", "-m", "initial"], projectDir);

      await writeFile(
        path.join(projectDir, ".patchworks.json"),
        JSON.stringify({
          commit: "nonexistent123abc",
          template: {
            repository: templateDir,
            branch: "main",
          },
        }),
        "utf8",
      );

      await git(["add", ".patchworks.json"], projectDir);
      await git(["commit", "-m", "add config"], projectDir);

      setWorkspaceForTesting(projectDir);

      await expect(runPatchworksUpdate()).rejects.toThrow(
        "not found on branch",
      );
    });

    it("returns hasChanges=false when already up to date", async () => {
      const templateDir = path.join(tempDir, "template");
      await git(["init", "--initial-branch=main", templateDir], tempDir);
      await git(["config", "user.name", "Test"], templateDir);
      await git(["config", "user.email", "test@example.com"], templateDir);
      await writeFile(path.join(templateDir, "file.txt"), "v1", "utf8");
      await git(["add", "file.txt"], templateDir);
      await git(["commit", "-m", "v1"], templateDir);
      const latestCommit = (await git(["rev-parse", "HEAD"], templateDir))
        .stdout;

      const projectDir = path.join(tempDir, "project");
      await git(["init", "--initial-branch=main", projectDir], tempDir);
      await git(["config", "user.name", "Test"], projectDir);
      await git(["config", "user.email", "test@example.com"], projectDir);
      await writeFile(path.join(projectDir, "file.txt"), "content", "utf8");
      await git(["add", "file.txt"], projectDir);
      await git(["commit", "-m", "initial"], projectDir);

      await writeFile(
        path.join(projectDir, ".patchworks.json"),
        JSON.stringify({
          commit: latestCommit,
          template: {
            repository: templateDir,
            branch: "main",
          },
        }),
        "utf8",
      );

      await git(["add", ".patchworks.json"], projectDir);
      await git(["commit", "-m", "add config"], projectDir);

      setWorkspaceForTesting(projectDir);

      const result = await runPatchworksUpdate();

      expect(result.hasChanges).toBe(false);
      expect(result.currentCommit).toBe(latestCommit);
      expect(result.nextCommit).toBe(latestCommit);
    });
  });
});
