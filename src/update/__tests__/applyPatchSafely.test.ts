import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  applyPatchSafely,
  setWorkspaceForTesting,
  type CommandResult,
  type GitRunner,
} from "../index";

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

describe("applyPatchSafely", () => {
  const originalWorkspace = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "patchworks-apply-"));
    setWorkspaceForTesting(tempDir);
  });

  afterEach(async () => {
    setWorkspaceForTesting(originalWorkspace);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns after first successful strategy", async () => {
    const gitRunner: GitRunner = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, "M file.txt"));
    const patchPath = path.join(tempDir, "patch.diff");
    await writeFile(patchPath, "", "utf8");

    await applyPatchSafely(patchPath, gitRunner);

    expect(gitRunner).toHaveBeenCalledTimes(2);
    expect(gitRunner).toHaveBeenNthCalledWith(
      1,
      [
        "apply",
        "--reject",
        "--whitespace=fix",
        "--ignore-space-change",
        "--ignore-whitespace",
        "--inaccurate-eof",
        patchPath,
      ],
      { allowFailure: true },
    );
    expect(gitRunner).toHaveBeenNthCalledWith(2, ["status", "--porcelain"]);
  });

  it("returns when a strategy leaves staged changes", async () => {
    const gitRunner: GitRunner = vi
      .fn()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0, " M file"));
    const patchPath = path.join(tempDir, "patch.diff");
    await writeFile(patchPath, "", "utf8");

    await applyPatchSafely(patchPath, gitRunner);

    expect(gitRunner).toHaveBeenCalledTimes(2);
  });

  it("throws with helpful context when patch fails with no changes", async () => {
    const gitRunner: GitRunner = vi
      .fn()
      .mockResolvedValueOnce(result(1, "STDOUT", "STDERR"))
      .mockResolvedValueOnce(result(0, ""));
    const patchPath = path.join(tempDir, "patch.diff");
    await writeFile(patchPath, "", "utf8");

    const error = await applyPatchSafely(patchPath, gitRunner).catch(
      (err: Error) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("Failed to apply template diff");
    expect(error?.message).toContain(
      `Git command: git apply --reject --whitespace=fix --ignore-space-change --ignore-whitespace --inaccurate-eof ${patchPath}`,
    );
    expect(error?.message).toContain("stdout:\nSTDOUT");
    expect(error?.message).toContain("stderr:\nSTDERR");
    expect(error?.message).toContain(`Patch file retained at: ${patchPath}`);

    expect(gitRunner).toHaveBeenCalledTimes(2);
  });

  it("creates placeholder for missing files to generate .rej files", async () => {
    const missingPath = "src/app/routes/-components/navbar/index.tsx";
    const diffContent = [
      `diff --git a/${missingPath} b/${missingPath}`,
      `--- a/${missingPath}`,
      `+++ b/${missingPath}`,
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const patchPath = path.join(tempDir, "patch.diff");
    await writeFile(patchPath, diffContent, "utf8");

    const gitRunner: GitRunner = vi
      .fn()
      .mockResolvedValueOnce(result(1, "", "error: patch failed"))
      .mockResolvedValueOnce(
        result(0, "?? src/app/routes/-components/navbar/index.tsx.rej"),
      );

    await applyPatchSafely(patchPath, gitRunner);

    // Should call git apply once, then git status
    expect(gitRunner).toHaveBeenCalledTimes(2);
    expect(gitRunner).toHaveBeenNthCalledWith(
      1,
      [
        "apply",
        "--reject",
        "--whitespace=fix",
        "--ignore-space-change",
        "--ignore-whitespace",
        "--inaccurate-eof",
        patchPath,
      ],
      { allowFailure: true },
    );
    expect(gitRunner).toHaveBeenNthCalledWith(2, ["status", "--porcelain"]);
  });
});
