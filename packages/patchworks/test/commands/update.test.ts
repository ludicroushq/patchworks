/* eslint-disable import-x/first */
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateResult = {
  status: "up-to-date" as const,
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
  currentCommit: "a".repeat(40),
  nextCommit: "a".repeat(40),
  warnings: [],
};

vi.mock("../../src/update/index.js", () => ({
  runPatchworksUpdate: vi.fn<
    (options?: { rebase?: boolean }) => Promise<typeof updateResult>
  >(async () => updateResult),
}));

import { updateCommand } from "../../src/commands/update.js";
import { runPatchworksUpdate } from "../../src/update/index.js";

const mockedUpdate = vi.mocked(runPatchworksUpdate);

describe("update command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a normal update without writing a report", async () => {
    const writeFile = vi.spyOn(fs, "writeFile").mockResolvedValue();
    await updateCommand.handler!({
      report: undefined,
      rebase: undefined,
    } as never);

    expect(mockedUpdate).toHaveBeenCalledWith({ rebase: false });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("forwards --rebase and writes the complete JSON report", async () => {
    const writeFile = vi.spyOn(fs, "writeFile").mockResolvedValue();
    await updateCommand.handler!({
      report: "output.json",
      rebase: true,
    } as never);

    expect(mockedUpdate).toHaveBeenCalledWith({ rebase: true });
    expect(writeFile).toHaveBeenCalledWith(
      "output.json",
      expect.stringContaining('"status": "up-to-date"'),
      "utf8",
    );
  });
});
