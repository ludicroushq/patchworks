import { $, fs } from "zx";
import simpleGit from "simple-git";
import path from "path";
import os from "os";

const git = simpleGit();

/**
 * Check if the current directory is a git repository
 */
export const isGitRepo = async (): Promise<boolean> => {
  try {
    await git.revparse(["--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Get the current commit hash
 */
export const getCurrentCommit = async (repoPath?: string): Promise<string> => {
  const gitInstance = repoPath ? simpleGit({ baseDir: repoPath }) : git;
  const result = await gitInstance.revparse(["HEAD"]);
  return result.trim();
};

/**
 * Clone a repository to a temporary directory
 */
export const cloneRepo = async (
  repoUrl: string,
  branch: string,
): Promise<string> => {
  const tempDir = path.join(os.tmpdir(), `patchworks-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  console.log(`Cloning ${repoUrl} (${branch}) to ${tempDir}...`);
  await simpleGit().clone(repoUrl, tempDir, [
    "--branch",
    branch,
    "--single-branch",
  ]);

  return tempDir;
};

/**
 * Generate a diff between two commits in a repository
 */
export const generateDiff = async (
  repoPath: string,
  fromCommit: string,
  toCommit: string = "HEAD",
): Promise<string> => {
  const gitInstance = simpleGit({ baseDir: repoPath });
  return gitInstance.diff([fromCommit, toCommit]);
};

/**
 * Apply a diff to the current repository
 */
export const applyDiff = async (diffContent: string): Promise<void> => {
  const tempDiffPath = path.join(
    os.tmpdir(),
    `patchworks-diff-${Date.now()}.patch`,
  );
  await fs.writeFile(tempDiffPath, diffContent);

  try {
    await $`git apply --reject --whitespace=fix ${tempDiffPath}`;
    console.log("Applied changes successfully");
  } catch (error) {
    console.error(
      "Failed to apply some changes. Check .rej files for conflicts.",
    );
    throw error;
  } finally {
    await fs.unlink(tempDiffPath).catch(() => {});
  }
};

/**
 * Create a new branch and commit changes
 */
export const createBranchAndCommit = async (
  branchName: string,
  commitMessage: string,
): Promise<void> => {
  await git.checkout(["-b", branchName]);
  await git.add(".");
  await git.commit(commitMessage);
};
