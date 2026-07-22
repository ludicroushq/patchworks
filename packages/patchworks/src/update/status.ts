import type { GitRunner } from "../core/git.js";

function splitNullTerminated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export async function isWorkingTreeDirty(
  gitRunner: GitRunner,
): Promise<boolean> {
  const result = await gitRunner([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return result.stdout.length > 0;
}

export async function describeWorkingTree(
  gitRunner: GitRunner,
): Promise<string> {
  const result = await gitRunner([
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  return result.stdout.trim();
}

export async function listChangedFiles(
  gitRunner: GitRunner,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitRunner(["diff", "--name-only", "-z", "HEAD", "--"]),
    gitRunner(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);

  return [
    ...new Set([
      ...splitNullTerminated(tracked.stdout),
      ...splitNullTerminated(untracked.stdout),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

export async function listStagedFiles(gitRunner: GitRunner): Promise<string[]> {
  const result = await gitRunner([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "HEAD",
    "--",
  ]);
  return splitNullTerminated(result.stdout).sort((left, right) =>
    left.localeCompare(right),
  );
}

export async function rollbackWorkingTree(gitRunner: GitRunner): Promise<void> {
  await gitRunner(["reset", "--hard", "HEAD"]);
  await gitRunner(["clean", "-fd"]);
}
