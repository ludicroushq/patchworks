import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPatchSafely,
  type CommandResult,
  type GitRunner,
} from "../../src/update/index.js";

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

describe("applyPatchSafely", () => {
  let workspace: string;
  let patchFile: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "patchworks-patch-"));
    patchFile = path.join(workspace, "input.patch");
    await writeFile(patchFile, "patch contents\n");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("checks a patch before applying it with exact whitespace", async () => {
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0));

    const applied = await applyPatchSafely(patchFile, runner, {
      workspace,
      nextCommit: "a".repeat(40),
    });

    expect(applied).toEqual({
      alreadyApplied: false,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: [],
    });
    expect(runner).toHaveBeenNthCalledWith(
      1,
      [
        "apply",
        "--check",
        "--index",
        "--binary",
        "--whitespace=nowarn",
        patchFile,
      ],
      { allowFailure: true },
    );
    expect(runner).toHaveBeenNthCalledWith(2, [
      "apply",
      "--index",
      "--binary",
      "--whitespace=nowarn",
      patchFile,
    ]);
  });

  it("recognizes a diff that downstream already applied", async () => {
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0));

    await expect(
      applyPatchSafely(patchFile, runner, {
        workspace,
        nextCommit: "b".repeat(40),
      }),
    ).resolves.toEqual({
      alreadyApplied: true,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: [],
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("retains a full patch artifact when exact application rejects hunks", async () => {
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1, "", "patch failed"));
    const commit = "c".repeat(40);

    const applied = await applyPatchSafely(patchFile, runner, {
      workspace,
      nextCommit: commit,
    });

    expect(applied).toEqual({
      alreadyApplied: false,
      hadConflicts: true,
      conflictArtifact: `.patchworks-rejects/${commit}/template.patch`,
      rejectArtifacts: [`.patchworks-rejects/${commit}/template.patch`],
      stagedPaths: [],
      diagnostic: "patch failed",
    });
    expect(
      await readFile(
        path.join(
          workspace,
          ".patchworks-rejects",
          commit,
          "template.patch",
        ),
        "utf8",
      ),
    ).toBe("patch contents\n");
  });

  it("never overwrites an existing conflict artifact", async () => {
    const runner = vi.fn<GitRunner>().mockResolvedValue(result(1));
    const commit = "d".repeat(40);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.join(workspace, ".patchworks-rejects", commit), {
        recursive: true,
      }),
    );
    const artifact = path.join(
      workspace,
      ".patchworks-rejects",
      commit,
      "template.patch",
    );
    await writeFile(artifact, "keep me\n");

    await expect(
      applyPatchSafely(patchFile, runner, { workspace, nextCommit: commit }),
    ).rejects.toThrow("Refusing to overwrite existing conflict artifacts");
    expect(await readFile(artifact, "utf8")).toBe("keep me\n");
    await expect(access(artifact)).resolves.toBeUndefined();
  });
});
