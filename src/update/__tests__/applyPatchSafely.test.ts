import { describe, expect, it, vi } from "vitest";
import { applyPatchSafely, type CommandResult, type GitRunner } from "../index";

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

describe("applyPatchSafely", () => {
  it("returns after first successful strategy", async () => {
    const gitRunner: GitRunner = vi.fn().mockResolvedValueOnce(result(0));

    await applyPatchSafely("patch.diff", gitRunner);

    expect(gitRunner).toHaveBeenCalledTimes(1);
    expect(gitRunner).toHaveBeenCalledWith(
      [
        "apply",
        "--reject",
        "--whitespace=fix",
        "--ignore-space-change",
        "--ignore-whitespace",
        "--inaccurate-eof",
        "patch.diff",
      ],
      { allowFailure: true },
    );
  });

  it("returns when a strategy leaves staged changes", async () => {
    const gitRunner: GitRunner = vi
      .fn()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0, " M file"));

    await applyPatchSafely("patch.diff", gitRunner);

    expect(gitRunner).toHaveBeenCalledTimes(2);
  });

  it("throws when patch fails with no changes", async () => {
    const gitRunner: GitRunner = vi
      .fn()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0, ""));

    await expect(applyPatchSafely("patch.diff", gitRunner)).rejects.toThrow(
      "Failed to apply template diff",
    );

    expect(gitRunner).toHaveBeenCalledTimes(2);
  });
});
