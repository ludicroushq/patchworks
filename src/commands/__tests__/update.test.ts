/* eslint-disable import-x/first */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it("invokes update without report file", async () => {
    await updateCommand.handler!({ report: undefined } as never);

    expect(mockedUpdate).toHaveBeenCalledWith();
  });

  it("writes JSON report when --report flag is provided", async () => {
    const mockWriteFile = vi.fn();
    vi.doMock("fs", () => ({
      promises: {
        writeFile: mockWriteFile,
      },
    }));

    await updateCommand.handler!({ report: "output.json" } as never);

    expect(mockedUpdate).toHaveBeenCalledWith();
  });
});
