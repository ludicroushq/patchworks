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

  it("sets environment overrides and uses non-destructive defaults", async () => {
    await updateCommand.handler!({
      token: "ghs_token",
      repository: "owner/repo",
      baseBranch: "main",
      branchName: "patchworks/custom",
      gitName: "Patchworks",
      gitEmail: "bot@patchworks.dev",
      commit: undefined,
      push: undefined,
      pr: undefined,
      outputFile: undefined,
    } as never);

    expect(process.env.GITHUB_TOKEN).toBe("ghs_token");
    expect(process.env.GITHUB_REPOSITORY).toBe("owner/repo");
    expect(process.env.PATCHWORKS_BASE_BRANCH).toBe("main");
    expect(process.env.PATCHWORKS_BRANCH_NAME).toBe("patchworks/custom");
    expect(process.env.PATCHWORKS_GIT_NAME).toBe("Patchworks");
    expect(process.env.PATCHWORKS_GIT_EMAIL).toBe("bot@patchworks.dev");

    expect(mockedUpdate).toHaveBeenCalledWith({
      commit: false,
      push: false,
      createPr: false,
      outputFile: undefined,
    });
  });

  it("honours CLI flags and writes metadata", async () => {
    await updateCommand.handler!({
      token: undefined,
      repository: undefined,
      baseBranch: undefined,
      branchName: undefined,
      gitName: undefined,
      gitEmail: undefined,
      commit: "true",
      push: "false",
      pr: "true",
      outputFile: "patchworks.json",
    } as never);

    expect(mockedUpdate).toHaveBeenCalledWith({
      commit: true,
      push: false,
      createPr: true,
      outputFile: "patchworks.json",
    });
  });
});
