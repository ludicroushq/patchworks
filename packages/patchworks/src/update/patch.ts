import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  rename,
} from "node:fs/promises";
import path from "node:path";
import type { GitRunner } from "../core/git.js";

export type PreparedPatchPath = {
  isGitlink: boolean;
  path: string;
  wasTracked: boolean;
};

export type PatchApplicationResult = {
  alreadyApplied: boolean;
  hadConflicts: boolean;
  conflictArtifact?: string;
  rejectArtifacts: string[];
  stagedPaths: string[];
  diagnostic?: string;
};

async function pathState(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function resolveSafePath(workspace: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Template patch contains an unsafe path: ${relativePath}`);
  }
  const resolved = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Template patch escapes the repository: ${relativePath}`);
  }
  return resolved;
}

async function assertSafeAncestors(
  workspace: string,
  filePath: string,
): Promise<void> {
  const relative = path.relative(workspace, path.dirname(filePath));
  if (!relative || relative === ".") {
    return;
  }

  let current = workspace;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const state = await pathState(current);
    if (!state) {
      return;
    }
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error(
        `Refusing to apply a template patch through unsafe path ${path.relative(workspace, current)}`,
      );
    }
  }
}

async function assertConflictDestination(
  workspace: string,
  commit: string,
): Promise<void> {
  const base = path.join(workspace, ".patchworks-rejects");
  const baseState = await pathState(base);
  if (baseState && (baseState.isSymbolicLink() || !baseState.isDirectory())) {
    throw new Error(
      ".patchworks-rejects must be a real directory (symbolic links are not allowed)",
    );
  }
  if (await pathState(path.join(base, commit))) {
    throw new Error(
      `Refusing to overwrite existing conflict artifacts for ${commit}`,
    );
  }
}

export async function preparePatchPaths(
  workspace: string,
  patchPaths: readonly string[],
  nextCommit: string,
  gitRunner: GitRunner,
  gitlinkPaths: ReadonlySet<string> = new Set(),
): Promise<PreparedPatchPath[]> {
  await assertConflictDestination(workspace, nextCommit);
  const prepared: PreparedPatchPath[] = [];

  for (const relativePath of [...new Set(patchPaths)]) {
    const target = resolveSafePath(workspace, relativePath);
    await assertSafeAncestors(workspace, target);
    const targetState = await pathState(target);
    const tracked = await gitRunner(
      ["ls-files", "--error-unmatch", "--", relativePath],
      { allowFailure: true },
    );
    const wasTracked = tracked.code === 0;
    if (!wasTracked && targetState) {
      throw new Error(
        `Template path ${relativePath} already exists as an ignored or untracked file. Patchworks will not overwrite it.`,
      );
    }

    const rejectPath = `${target}.rej`;
    if (await pathState(rejectPath)) {
      throw new Error(
        `Reject path ${relativePath}.rej already exists. Remove or preserve it elsewhere before updating.`,
      );
    }
    prepared.push({
      isGitlink: gitlinkPaths.has(relativePath),
      path: relativePath,
      wasTracked,
    });
  }

  return prepared;
}

async function markNewFilesForReview(
  workspace: string,
  paths: readonly string[],
  gitRunner: GitRunner,
): Promise<void> {
  const existing: string[] = [];
  for (const relativePath of paths) {
    if (await pathState(resolveSafePath(workspace, relativePath))) {
      existing.push(relativePath);
    }
  }

  for (let index = 0; index < existing.length; index += 200) {
    await gitRunner([
      "add",
      "--intent-to-add",
      "--force",
      "--",
      ...existing.slice(index, index + 200),
    ]);
  }
}

async function unstageForReview(
  workspace: string,
  preparedPaths: readonly PreparedPatchPath[],
  gitRunner: GitRunner,
): Promise<void> {
  const ordinaryPaths = preparedPaths.filter(({ isGitlink }) => !isGitlink);
  for (let index = 0; index < ordinaryPaths.length; index += 200) {
    await gitRunner([
      "reset",
      "--mixed",
      "--quiet",
      "HEAD",
      "--",
      ...ordinaryPaths.slice(index, index + 200).map(({ path }) => path),
    ]);
  }
  await markNewFilesForReview(
    workspace,
    ordinaryPaths
      .filter(({ wasTracked }) => !wasTracked)
      .map(({ path }) => path),
    gitRunner,
  );
}

async function createConflictArtifacts(
  workspace: string,
  patchFile: string,
  commit: string,
  preparedPaths: readonly PreparedPatchPath[],
): Promise<{ fullPatch: string; rejectArtifacts: string[] }> {
  const base = path.join(workspace, ".patchworks-rejects");
  const directory = path.join(base, commit);
  await mkdir(base, { recursive: true, mode: 0o755 });
  const baseState = await lstat(base);
  if (baseState.isSymbolicLink() || !baseState.isDirectory()) {
    throw new Error(
      ".patchworks-rejects must be a real directory (symbolic links are not allowed)",
    );
  }
  await mkdir(directory, { mode: 0o755 });

  const fullPatchPath = path.join(directory, "template.patch");
  await copyFile(patchFile, fullPatchPath, constants.COPYFILE_EXCL);
  const rejectArtifacts: string[] = [];

  for (const prepared of preparedPaths) {
    const source = `${resolveSafePath(workspace, prepared.path)}.rej`;
    const sourceState = await pathState(source);
    if (!sourceState) {
      continue;
    }
    if (sourceState.isSymbolicLink() || !sourceState.isFile()) {
      throw new Error(`Git produced an unsafe reject path: ${prepared.path}.rej`);
    }

    const destination = resolveSafePath(
      workspace,
      path.join(
        ".patchworks-rejects",
        commit,
        "files",
        `${prepared.path}.rej`,
      ),
    );
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await rename(source, destination);
    rejectArtifacts.push(path.relative(workspace, destination));
  }

  return {
    fullPatch: path.relative(workspace, fullPatchPath),
    rejectArtifacts,
  };
}

export async function applyPatch(
  workspace: string,
  patchFile: string,
  nextCommit: string,
  preparedPaths: readonly PreparedPatchPath[],
  gitRunner: GitRunner,
): Promise<PatchApplicationResult> {
  const commonArguments = ["--binary", "--whitespace=nowarn", patchFile];
  const check = await gitRunner(
    ["apply", "--check", "--index", ...commonArguments],
    { allowFailure: true },
  );

  if (check.code === 0) {
    await gitRunner(["apply", "--index", ...commonArguments]);
    await unstageForReview(workspace, preparedPaths, gitRunner);
    return {
      alreadyApplied: false,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: preparedPaths
        .filter(({ isGitlink }) => isGitlink)
        .map(({ path }) => path),
    };
  }

  const reverseCheck = await gitRunner(
    ["apply", "--check", "--reverse", "--index", ...commonArguments],
    { allowFailure: true },
  );
  if (reverseCheck.code === 0) {
    return {
      alreadyApplied: true,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: [],
    };
  }

  const result = await gitRunner(
    ["apply", "--reject", ...commonArguments],
    { allowFailure: true },
  );
  const hasGitlink = preparedPaths.some(({ isGitlink }) => isGitlink);
  if (result.code === 0 && !hasGitlink) {
    await markNewFilesForReview(
      workspace,
      preparedPaths.filter(({ wasTracked }) => !wasTracked).map(({ path }) => path),
      gitRunner,
    );
    return {
      alreadyApplied: false,
      hadConflicts: false,
      rejectArtifacts: [],
      stagedPaths: [],
    };
  }

  const artifacts = await createConflictArtifacts(
    workspace,
    patchFile,
    nextCommit,
    preparedPaths,
  );
  await markNewFilesForReview(
    workspace,
    [
      ...preparedPaths
        .filter(({ wasTracked }) => !wasTracked)
        .map(({ path }) => path),
      artifacts.fullPatch,
      ...artifacts.rejectArtifacts,
    ],
    gitRunner,
  );
  const diagnostic = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n");

  return {
    alreadyApplied: false,
    hadConflicts: true,
    conflictArtifact: artifacts.fullPatch,
    rejectArtifacts: [artifacts.fullPatch, ...artifacts.rejectArtifacts],
    stagedPaths: [],
    ...(diagnostic ? { diagnostic } : {}),
  };
}
