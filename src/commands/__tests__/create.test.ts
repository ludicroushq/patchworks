import { describe, expect, it } from "vitest";
import { createPatchworksCommitEnv } from "../create";

describe("createPatchworksCommitEnv", () => {
  it("removes git env hooks blocked by simple-git", () => {
    const commitEnv = createPatchworksCommitEnv({
      EDITOR: "code",
      GIT_ASKPASS: "/tmp/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      GIT_CONFIG_VALUE_0: "less",
      GIT_EDITOR: "vim",
      GIT_EXTERNAL_DIFF: "diff-tool",
      GIT_PAGER: "cat",
      GIT_SEQUENCE_EDITOR: "vim",
      GIT_SSH_COMMAND: "ssh -i key",
      PAGER: "less",
      PREFIX: "/tmp/prefix",
      SSH_ASKPASS: "/tmp/ssh-askpass",
      PATH: "/usr/bin",
      HOME: "/Users/test",
      GITHUB_TOKEN: "token",
      GIT_AUTHOR_NAME: "Local User",
      GIT_AUTHOR_EMAIL: "local@example.com",
    });

    expect(commitEnv).not.toHaveProperty("EDITOR");
    expect(commitEnv).not.toHaveProperty("GIT_ASKPASS");
    expect(commitEnv).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(commitEnv).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(commitEnv).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    expect(commitEnv).not.toHaveProperty("GIT_EDITOR");
    expect(commitEnv).not.toHaveProperty("GIT_EXTERNAL_DIFF");
    expect(commitEnv).not.toHaveProperty("GIT_PAGER");
    expect(commitEnv).not.toHaveProperty("GIT_SEQUENCE_EDITOR");
    expect(commitEnv).not.toHaveProperty("GIT_SSH_COMMAND");
    expect(commitEnv).not.toHaveProperty("PAGER");
    expect(commitEnv).not.toHaveProperty("PREFIX");
    expect(commitEnv).not.toHaveProperty("SSH_ASKPASS");
    expect(commitEnv.PATH).toBe("/usr/bin");
    expect(commitEnv.HOME).toBe("/Users/test");
    expect(commitEnv.GITHUB_TOKEN).toBe("token");
    expect(commitEnv.GIT_AUTHOR_NAME).toBe("Patchworks");
    expect(commitEnv.GIT_AUTHOR_EMAIL).toBe("bot@patchworks.dev");
    expect(commitEnv.GIT_COMMITTER_NAME).toBe("Patchworks");
    expect(commitEnv.GIT_COMMITTER_EMAIL).toBe("bot@patchworks.dev");
  });
});
