import { describe, expect, it, vi } from "vitest";
import type { GitRunner } from "../../src/core/git.js";
import {
  describeWorkingTree,
  isWorkingTreeDirty,
  listChangedFiles,
  listStagedFiles,
  rollbackWorkingTree,
} from "../../src/update/status.js";

function result(stdout = "") {
  return { code: 0, stderr: "", stdout };
}

describe("working-tree status helpers", () => {
  it("detects and describes dirty files", async () => {
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result(" M file\0"))
      .mockResolvedValueOnce(result(" M file\n"));
    await expect(isWorkingTreeDirty(runner)).resolves.toBe(true);
    await expect(describeWorkingTree(runner)).resolves.toBe("M file");
  });

  it("combines tracked and untracked paths without duplicates", async () => {
    const runner = vi
      .fn<GitRunner>()
      .mockResolvedValueOnce(result("b.txt\0a.txt\0"))
      .mockResolvedValueOnce(result("a.txt\0new.txt\0"));
    await expect(listChangedFiles(runner)).resolves.toEqual([
      "a.txt",
      "b.txt",
      "new.txt",
    ]);
  });

  it("lists staged paths in stable order", async () => {
    const runner = vi.fn<GitRunner>().mockResolvedValue(result("z\0a\0"));
    await expect(listStagedFiles(runner)).resolves.toEqual(["a", "z"]);
  });

  it("restores the tracked tree and removes generated untracked files", async () => {
    const runner = vi.fn<GitRunner>().mockResolvedValue(result());
    await rollbackWorkingTree(runner);
    expect(runner).toHaveBeenNthCalledWith(1, ["reset", "--hard", "HEAD"]);
    expect(runner).toHaveBeenNthCalledWith(2, ["clean", "-fd"]);
  });
});
