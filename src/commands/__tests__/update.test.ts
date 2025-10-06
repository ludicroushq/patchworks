/* eslint-disable import-x/first */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../update/index.js", () => ({
  runPatchworksUpdate: vi.fn(async () => ({
    hasChanges: false,
    branchName: "patchworks/update",
    baseBranch: "main",
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

  it("invokes update in non-destructive mode", async () => {
    await updateCommand.handler!({ json: undefined } as never);

    expect(mockedUpdate).toHaveBeenCalledWith({ silent: false });
  });

  it("emits JSON when requested", async () => {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand.handler!({ json: "true" } as never);

    expect(mockedUpdate).toHaveBeenCalledWith({ silent: true });
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/"hasChanges":false/),
    );

    spy.mockRestore();
  });
});
