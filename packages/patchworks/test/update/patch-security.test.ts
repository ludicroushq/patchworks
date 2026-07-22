import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRunner } from "../../src/core/git.js";
import {
  applyPatch,
  preparePatchPaths,
} from "../../src/update/patch.js";

function result(code = 0, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

describe("patch path safety", () => {
  let workspace: string;
  const commit = "e".repeat(40);

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "patchworks-paths-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("rejects absolute paths and paths escaping the repository", async () => {
    const runner = vi.fn<GitRunner>();
    await expect(
      preparePatchPaths(workspace, ["../outside"], commit, runner),
    ).rejects.toThrow("escapes the repository");
    await expect(
      preparePatchPaths(workspace, [path.join(workspace, "absolute")], commit, runner),
    ).rejects.toThrow("unsafe path");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects symlink ancestors and preexisting reject files", async () => {
    const outside = path.join(workspace, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(workspace, "linked"));
    const runner = vi.fn<GitRunner>();
    await expect(
      preparePatchPaths(workspace, ["linked/file.txt"], commit, runner),
    ).rejects.toThrow("unsafe path linked");

    await writeFile(path.join(workspace, "file.txt.rej"), "preserve\n");
    const trackedRunner = vi.fn<GitRunner>().mockResolvedValue(result(0));
    await expect(
      preparePatchPaths(workspace, ["file.txt"], commit, trackedRunner),
    ).rejects.toThrow("Reject path file.txt.rej already exists");
  });

  it("rejects an untracked or ignored target that already exists", async () => {
    await writeFile(path.join(workspace, ".env.local"), "secret\n");
    const runner = vi.fn<GitRunner>().mockResolvedValue(result(1));
    await expect(
      preparePatchPaths(workspace, [".env.local"], commit, runner),
    ).rejects.toThrow("already exists as an ignored or untracked file");
  });

  it("allows a tracked target and records whether new paths need intent-to-add", async () => {
    await writeFile(path.join(workspace, "tracked.txt"), "value\n");
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1));
    await expect(
      preparePatchPaths(
        workspace,
        ["tracked.txt", "new.txt"],
        commit,
        runner,
      ),
    ).resolves.toEqual([
      { isGitlink: false, path: "tracked.txt", wasTracked: true },
      { isGitlink: false, path: "new.txt", wasTracked: false },
    ]);
  });

  it("handles a reject-mode apply that ultimately succeeds", async () => {
    const patchFile = path.join(workspace, "change.patch");
    await writeFile(patchFile, "patch\n");
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0));

    await expect(
      applyPatch(workspace, patchFile, commit, [], runner),
    ).resolves.toEqual({
      alreadyApplied: false,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: [],
    });
    expect(runner).toHaveBeenCalledTimes(3);
  });
});
