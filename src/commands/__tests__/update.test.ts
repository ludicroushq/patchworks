/* eslint-disable import-x/first */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { promises as fs } from "fs";

vi.mock("../../update/index.js", () => ({
  runPatchworksUpdate: vi.fn(async () => ({
    hasChanges: false,
    commitMessage: "",
    prTitle: "",
    prBody: "",
    rejectFiles: [],
    currentCommit: "abc",
    nextCommit: "abc",
  })),
}));

import { updateCommand } from "../update";
import { runPatchworksUpdate } from "../../update/index.js";

const mockedUpdate = vi.mocked(runPatchworksUpdate);
const originalEnv = { ...process.env };

describe("update command", () => {
  let writeFileSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
  });

  it("invokes update without report file", async () => {
    await updateCommand.handler!({ report: undefined } as never);

    expect(mockedUpdate).toHaveBeenCalledWith();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("writes JSON report when --report flag is provided", async () => {
    await updateCommand.handler!({ report: "output.json" } as never);

    expect(mockedUpdate).toHaveBeenCalledWith();
    expect(writeFileSpy).toHaveBeenCalledWith(
      "output.json",
      expect.stringContaining('"hasChanges": false'),
      "utf8",
    );
  });
});
