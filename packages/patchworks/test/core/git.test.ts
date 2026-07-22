import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitRunner,
  formatGitCommand,
} from "../../src/core/git.js";
import { commitAll, initializeGitRepository } from "../update/helpers.js";

describe("Git process runner", () => {
  let repository: string;

  beforeEach(async () => {
    repository = await mkdtemp(path.join(tmpdir(), "patchworks-git-runner-"));
    await initializeGitRepository(repository);
    await writeFile(path.join(repository, "file with spaces.txt"), "content\n");
    await commitAll(repository, "initial");
  });

  afterEach(async () => {
    await rm(repository, { recursive: true, force: true });
  });

  it("runs Git without a shell and accepts standard input", async () => {
    const runner = createGitRunner(repository);
    const root = await runner(["rev-parse", "--show-toplevel"]);
    expect(await realpath(root.stdout.trim())).toBe(await realpath(repository));

    const object = await runner(["hash-object", "--stdin"], {
      input: "from stdin\n",
    });
    expect(object.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns allowed failures and throws useful errors otherwise", async () => {
    const runner = createGitRunner(repository);
    const allowed = await runner(["rev-parse", "not-a-ref"], {
      allowFailure: true,
    });
    expect(allowed.code).not.toBe(0);
    expect(allowed.stderr).toContain("unknown revision");

    await expect(runner(["rev-parse", "not-a-ref"])).rejects.toThrow(
      "git rev-parse not-a-ref failed with exit code",
    );
  });

  it("caps collected output", async () => {
    const runner = createGitRunner(repository);
    await expect(
      runner(["show", "HEAD:file with spaces.txt"], { maxOutputBytes: 2 }),
    ).rejects.toThrow("produced more than 2 bytes");
  });

  it("quotes display-only command arguments", () => {
    expect(formatGitCommand(["show", "file with spaces.txt"])).toBe(
      'git show "file with spaces.txt"',
    );
    expect(formatGitCommand(["status", "--short"])).toBe(
      "git status --short",
    );
  });
});
