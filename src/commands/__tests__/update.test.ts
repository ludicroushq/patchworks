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

  it("sets environment overrides and invokes update in non-destructive mode", async () => {
    await updateCommand.handler!({
      token: "ghs_token",
      repository: "owner/repo",
      baseBranch: "main",
      branchName: "patchworks/custom",
      gitName: "Patchworks",
      gitEmail: "bot@patchworks.dev",
      json: undefined,
    } as never);

    expect(process.env.GITHUB_TOKEN).toBe("ghs_token");
    expect(process.env.GITHUB_REPOSITORY).toBe("owner/repo");
    expect(process.env.PATCHWORKS_BASE_BRANCH).toBe("main");
    expect(process.env.PATCHWORKS_BRANCH_NAME).toBe("patchworks/custom");
    expect(process.env.PATCHWORKS_GIT_NAME).toBe("Patchworks");
    expect(process.env.PATCHWORKS_GIT_EMAIL).toBe("bot@patchworks.dev");

    expect(mockedUpdate).toHaveBeenCalledWith({ silent: false });
  });

  it("emits JSON when requested", async () => {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand.handler!({
      token: undefined,
      repository: undefined,
      baseBranch: undefined,
      branchName: undefined,
      gitName: undefined,
      gitEmail: undefined,
      json: "true",
    } as never);

    expect(mockedUpdate).toHaveBeenCalledWith({ silent: true });
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/"hasChanges":false/),
    );

    spy.mockRestore();
  });
});
