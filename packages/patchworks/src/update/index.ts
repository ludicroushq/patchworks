import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  createGitRunner,
  type CommandResult,
  type GitRunner,
} from "../core/git.js";
import {
  readPatchworksConfig,
  writePatchworksConfig,
} from "./config.js";
import {
  buildPullRequestBody,
  toCommitUrl,
  toCompareUrl,
} from "./github.js";
import {
  applyPatch,
  preparePatchPaths,
  type PatchApplicationResult,
  type PreparedPatchPath,
} from "./patch.js";
import {
  describeWorkingTree,
  isWorkingTreeDirty,
  listChangedFiles,
  listStagedFiles,
  rollbackWorkingTree,
} from "./status.js";

export type { CommandResult, GitRunner } from "../core/git.js";
export type { PatchworksConfig } from "./config.js";
export {
  buildPullRequestBody,
  parseGithubSlug,
  toCommitUrl,
  toCompareUrl,
} from "./github.js";

const LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PATCH_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

let testingWorkspace: string | undefined;

/** @deprecated Prefer the `workspace` option. This helper does not change cwd. */
export function setWorkspaceForTesting(newWorkspace: string): void {
  testingWorkspace = path.resolve(newWorkspace);
}

function initialWorkspace(explicitWorkspace?: string): string {
  return path.resolve(
    explicitWorkspace ??
      testingWorkspace ??
      process.env.GITHUB_WORKSPACE ??
      process.cwd(),
  );
}

async function repositoryRoot(
  candidate: string,
  injectedRunner?: GitRunner,
): Promise<{ workspace: string; gitRunner: GitRunner }> {
  if (injectedRunner) {
    return { workspace: candidate, gitRunner: injectedRunner };
  }

  const candidateRunner = createGitRunner(candidate);
  const result = await candidateRunner(["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Patchworks must run inside a Git working tree (started from ${candidate})`,
    );
  }

  const workspace = await realpath(result.stdout.trim());
  return { workspace, gitRunner: createGitRunner(workspace) };
}

async function acquireRunLock(
  workspace: string,
  gitRunner: GitRunner,
): Promise<() => Promise<void>> {
  const gitPath = await gitRunner(["rev-parse", "--git-path", "patchworks.lock"]);
  const value = gitPath.stdout.trim();
  const lockPath = path.isAbsolute(value) ? value : path.resolve(workspace, value);
  const token = `${process.pid}:${randomUUID()}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      await handle.close();

      return async () => {
        try {
          const contents = await readFile(lockPath, "utf8");
          const parsed = JSON.parse(contents) as { token?: string };
          if (parsed.token === token) {
            await unlink(lockPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs <= LOCK_MAX_AGE_MS || attempt > 0) {
        throw new Error(
          `Another Patchworks update appears to be running (${lockPath}). If it is not, remove this lock file and retry.`,
        );
      }
      await unlink(lockPath);
    }
  }

  throw new Error("Unable to acquire the Patchworks update lock");
}

async function validateBranch(
  branch: string,
  gitRunner: GitRunner,
): Promise<void> {
  if (
    branch.includes("\0") ||
    branch.includes("\r") ||
    branch.includes("\n") ||
    branch.startsWith("-")
  ) {
    throw new Error(`Invalid template branch: ${JSON.stringify(branch)}`);
  }
  const result = await gitRunner(["check-ref-format", "--branch", branch], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    throw new Error(`Invalid template branch: ${JSON.stringify(branch)}`);
  }
}

async function fetchRef(
  gitRunner: GitRunner,
  repository: string,
  source: string,
  destination: string,
): Promise<CommandResult> {
  return gitRunner(
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--force",
      repository,
      `+${source}:${destination}`,
    ],
    { allowFailure: true },
  );
}

async function commitMessage(
  gitRunner: GitRunner,
  commit: string,
): Promise<{ subject: string; body: string }> {
  const result = await gitRunner([
    "show",
    "--no-patch",
    "--format=%s%x00%b",
    commit,
  ]);
  const separator = result.stdout.indexOf("\0");
  if (separator < 0) {
    return { subject: result.stdout.trim(), body: "" };
  }
  return {
    subject: result.stdout.slice(0, separator).trim(),
    body: result.stdout.slice(separator + 1).trim(),
  };
}

async function hasCommit(
  gitRunner: GitRunner,
  commit: string,
): Promise<boolean> {
  const result = await gitRunner(["cat-file", "-e", `${commit}^{commit}`], {
    allowFailure: true,
  });
  return result.code === 0;
}

function emptyResult(commit: string): PatchworksResult {
  return {
    status: "up-to-date",
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
    currentCommit: commit,
    nextCommit: commit,
    warnings: [],
  };
}

export type PatchworksStatus = "up-to-date" | "updated" | "conflicts";

export type PatchworksResult = {
  status: PatchworksStatus;
  hasChanges: boolean;
  hadConflicts: boolean;
  rebased: boolean;
  workflowChanges: boolean;
  changedFiles: string[];
  stagedFiles: string[];
  commitMessage: string;
  prTitle: string;
  prBody: string;
  rejectFiles: string[];
  currentCommit: string;
  nextCommit: string;
  warnings: string[];
};

type PatchworksDependencies = {
  gitRunner: GitRunner;
};

export type PatchworksRunOptions = Partial<PatchworksDependencies> & {
  workspace?: string;
  rebase?: boolean;
  /** @deprecated Updates are intentionally left in the working tree. */
  commit?: boolean;
  /** @deprecated The CLI never pushes repository changes. */
  push?: boolean;
  /** @deprecated Pull requests are managed by the GitHub Action. */
  createPr?: boolean;
};

export async function applyPatchSafely(
  patchFile: string,
  gitRunner: GitRunner,
  options: {
    workspace?: string;
    nextCommit?: string;
    patchPaths?: string[];
  } = {},
): Promise<PatchApplicationResult> {
  const workspace = initialWorkspace(options.workspace);
  const nextCommit = options.nextCommit ?? "manual-conflict";
  const preparedPaths = await preparePatchPaths(
    workspace,
    options.patchPaths ?? [],
    nextCommit,
    gitRunner,
  );
  return applyPatch(
    workspace,
    patchFile,
    nextCommit,
    preparedPaths,
    gitRunner,
  );
}

function gitlinkPathsFromRawDiff(output: string): Set<string> {
  const records = output.split("\0");
  const gitlinks = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const metadata = records[index];
    if (!metadata?.startsWith(":")) {
      continue;
    }
    const fields = metadata.slice(1).split(" ");
    const filePath = records[index + 1];
    if (!filePath) {
      continue;
    }
    if (fields[0] === "160000" || fields[1] === "160000") {
      gitlinks.add(filePath);
    }
    index += 1;
  }
  return gitlinks;
}

export async function runPatchworksUpdate(
  options: PatchworksRunOptions = {},
): Promise<PatchworksResult> {
  const root = await repositoryRoot(
    initialWorkspace(options.workspace),
    options.gitRunner,
  );
  const { workspace, gitRunner } = root;
  const releaseLock = await acquireRunLock(workspace, gitRunner);
  const temporaryRefs: string[] = [];
  let temporaryDirectory: string | undefined;
  let worktreeMutated = false;
  let preparedPatchPaths: PreparedPatchPath[] = [];
  let attemptedCommit: string | undefined;

  try {
    console.log(`Running Patchworks update from ${workspace}`);
    const configFile = await readPatchworksConfig(workspace);
    const config = configFile.config;
    const templateBranch = config.template.branch ?? "main";
    const templateRepo = config.template.repository;
    const currentCommit = config.commit.toLowerCase();
    await validateBranch(templateBranch, gitRunner);

    if (await isWorkingTreeDirty(gitRunner)) {
      const detail = await describeWorkingTree(gitRunner);
      throw new Error(
        `Working tree is not clean before running Patchworks update. Commit, stash, or remove pending changes first.${detail ? `\n\nDirty files:\n${detail}` : ""}`,
      );
    }

    console.log(
      `Template repository: ${templateRepo} (branch ${JSON.stringify(templateBranch)})`,
    );
    console.log(`Current template commit: ${currentCommit.slice(0, 12)}`);
    console.log("Fetching template history...");

    const refSuffix = `${process.pid}-${randomUUID()}`;
    const templateRef = `refs/patchworks/template-${refSuffix}`;
    temporaryRefs.push(templateRef);
    const fetchResult = await fetchRef(
      gitRunner,
      templateRepo,
      `refs/heads/${templateBranch}`,
      templateRef,
    );
    if (fetchResult.code !== 0) {
      const detail = fetchResult.stderr.trim() || fetchResult.stdout.trim();
      throw new Error(
        `Unable to fetch template branch ${JSON.stringify(templateBranch)} from ${templateRepo}.${detail ? `\n${detail}` : ""}`,
      );
    }

    const tip = (await gitRunner(["rev-parse", templateRef])).stdout.trim();
    let currentExists = await hasCommit(gitRunner, currentCommit);
    if (!currentExists && options.rebase) {
      const currentRef = `refs/patchworks/current-${refSuffix}`;
      temporaryRefs.push(currentRef);
      const currentFetch = await fetchRef(
        gitRunner,
        templateRepo,
        currentCommit,
        currentRef,
      );
      currentExists = currentFetch.code === 0;
    }
    if (!currentExists) {
      throw new Error(
        `Tracked template commit ${currentCommit} is unavailable. The template may have rewritten or pruned its history; restore that object or migrate .patchworks.json deliberately before retrying.`,
      );
    }

    if (currentCommit === tip) {
      console.log("Repository already matches the latest template commit.");
      return emptyResult(currentCommit);
    }

    const history = (
      await gitRunner(["rev-list", "--first-parent", templateRef])
    ).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const currentIndex = history.indexOf(currentCommit);
    const rebased = currentIndex < 0;
    if (rebased && !options.rebase) {
      throw new Error(
        `Tracked template commit ${currentCommit} is not on the first-parent history of ${templateBranch}. The branch may have been rewritten or the commit may come from a merged side branch. Review the new history, then rerun with --rebase to apply the aggregate old-to-new template diff explicitly.`,
      );
    }

    const nextCommit = rebased ? tip : history[currentIndex - 1];
    if (!nextCommit) {
      throw new Error(
        `Unable to determine the next first-parent template commit after ${currentCommit}`,
      );
    }
    console.log(
      `${rebased ? "Rebasing template history" : "Next template commit"}: ${currentCommit.slice(0, 12)} -> ${nextCommit.slice(0, 12)}`,
    );

    const metadata = await commitMessage(gitRunner, nextCommit);
    const pathspec = ["--", ".", ":(exclude).patchworks.json"];
    const [diff, patchPathResult, rawDiff] = await Promise.all([
      gitRunner(
        [
          "diff",
          "--binary",
          "--full-index",
          "--find-renames",
          currentCommit,
          nextCommit,
          ...pathspec,
        ],
        { maxOutputBytes: PATCH_MAX_OUTPUT_BYTES },
      ),
      gitRunner([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        currentCommit,
        nextCommit,
        ...pathspec,
      ]),
      gitRunner([
        "diff",
        "--raw",
        "--no-renames",
        "-z",
        currentCommit,
        nextCommit,
        ...pathspec,
      ]),
    ]);

    let patchResult: PatchApplicationResult = {
      alreadyApplied: false,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: [],
    };
    if (diff.stdout.length > 0) {
      temporaryDirectory = await mkdtemp(path.join(tmpdir(), "patchworks-"));
      const patchFile = path.join(temporaryDirectory, `${nextCommit}.patch`);
      await writeFile(patchFile, diff.stdout, { encoding: "utf8", flag: "wx" });
      const patchPaths = patchPathResult.stdout.split("\0").filter(Boolean);
      preparedPatchPaths = await preparePatchPaths(
        workspace,
        patchPaths,
        nextCommit,
        gitRunner,
        gitlinkPathsFromRawDiff(rawDiff.stdout),
      );
      attemptedCommit = nextCommit;
      worktreeMutated = true;
      patchResult = await applyPatch(
        workspace,
        patchFile,
        nextCommit,
        preparedPatchPaths,
        gitRunner,
      );
    }

    worktreeMutated = true;
    await writePatchworksConfig(
      configFile.path,
      { ...config, commit: nextCommit },
      configFile.mode,
    );

    const changedFiles = await listChangedFiles(gitRunner);
    const stagedFiles = await listStagedFiles(gitRunner);
    const rejectFiles = [
      ...new Set([
        ...changedFiles.filter(
          (file) =>
            file.endsWith(".rej") || file.startsWith(".patchworks-rejects/"),
        ),
        ...patchResult.rejectArtifacts,
      ]),
    ].sort((left, right) => left.localeCompare(right));
    const hadConflicts = patchResult.hadConflicts || rejectFiles.length > 0;
    const workflowChanges = changedFiles.some((file) =>
      file.startsWith(".github/workflows/"),
    );
    const shortCurrent = currentCommit.slice(0, 7);
    const shortNext = nextCommit.slice(0, 7);
    const commitSummary = rebased
      ? `Patchworks: rebase ${shortCurrent} -> ${shortNext}`
      : `Patchworks: sync ${shortCurrent} -> ${shortNext}`;
    const prTitle = rebased
      ? `Patchworks rebase: ${shortNext}`
      : `Patchworks update: ${shortNext}`;
    const warnings = [
      patchResult.alreadyApplied
        ? "The template diff was already present; only the tracking commit changed."
        : undefined,
      stagedFiles.length > 0
        ? `Gitlink changes must remain staged; review them with git diff --cached: ${stagedFiles.join(", ")}`
        : undefined,
      patchResult.diagnostic
        ? `Git reported rejected hunks. Review ${patchResult.conflictArtifact ?? "the reject artifacts"}.`
        : undefined,
    ].filter((warning): warning is string => Boolean(warning));
    const prBody = buildPullRequestBody({
      templateRepo,
      templateBranch,
      currentCommit,
      nextCommit,
      commitSubject: metadata.subject,
      commitBody: metadata.body,
      compareUrl: toCompareUrl(templateRepo, currentCommit, nextCommit),
      commitUrl: toCommitUrl(templateRepo, nextCommit),
      rejectFiles,
      rebased,
    });

    console.log(
      hadConflicts
        ? "Patchworks prepared the update with conflicts that require review."
        : "Patchworks update prepared successfully.",
    );
    return {
      status: hadConflicts ? "conflicts" : "updated",
      hasChanges: changedFiles.length > 0,
      hadConflicts,
      rebased,
      workflowChanges,
      changedFiles,
      stagedFiles,
      commitMessage: commitSummary,
      prTitle,
      prBody,
      rejectFiles,
      currentCommit,
      nextCommit,
      warnings,
    };
  } catch (error) {
    if (worktreeMutated) {
      try {
        await rollbackWorkingTree(gitRunner);
        for (const prepared of preparedPatchPaths) {
          await rm(`${path.join(workspace, prepared.path)}.rej`, {
            force: true,
          });
          if (!prepared.wasTracked) {
            await rm(path.join(workspace, prepared.path), {
              force: true,
              recursive: true,
            });
          }
        }
        if (attemptedCommit) {
          await rm(
            path.join(workspace, ".patchworks-rejects", attemptedCommit),
            { force: true, recursive: true },
          );
        }
      } catch (rollbackError) {
        const original = error instanceof Error ? error.message : String(error);
        const rollback =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        throw new Error(
          `${original}\n\nPatchworks also failed to restore the initially clean working tree:\n${rollback}`,
        );
      }
    }
    throw error;
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    for (const reference of temporaryRefs) {
      await gitRunner(["update-ref", "-d", reference], {
        allowFailure: true,
      });
    }
    await releaseLock();
  }
}
