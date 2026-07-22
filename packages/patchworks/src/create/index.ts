import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { version } from "../../package.json";

const CONFIG_PATH = ".patchworks.json";
const WORKFLOW_PATH = ".github/workflows/patchworks.yaml";

const unsafeGitEnvKeys = new Set([
  "EDITOR",
  "PAGER",
  "PREFIX",
  "SSH_ASKPASS",
]);

type GitOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

type PathState = Awaited<ReturnType<typeof lstat>> | null;

type GitIdentity = {
  email: string;
  name: string;
};

export type CreateRepositoryOptions = {
  branch?: string;
  destination: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
  repoUrl: string;
};

export type CreateRepositoryResult = {
  branch: string;
  destination: string;
  initialCommit: string;
  templateCommit: string;
};

class GitCommandError extends Error {
  readonly code: number | null;

  constructor(args: string[], code: number | null, stderr: string) {
    const detail = stderr.trim();
    super(
      `git ${args.join(" ")} failed${code === null ? "" : ` with exit code ${code}`}${
        detail.length === 0 ? "" : `:\n${detail}`
      }`,
    );
    this.name = "GitCommandError";
    this.code = code;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

async function pathState(filePath: string): Promise<PathState> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function runGit(args: string[], options: GitOptions): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(new GitCommandError(args, code, stderr));
    });
  });
}

function githubActionsIdentity(
  env: NodeJS.ProcessEnv,
): GitIdentity | undefined {
  if (env.GITHUB_ACTIONS !== "true") {
    return undefined;
  }

  const actor = env.GITHUB_ACTOR;
  if (!actor || !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(actor)) {
    throw new Error(
      "GITHUB_ACTOR is missing or invalid; Patchworks cannot create attributed commits in GitHub Actions.",
    );
  }

  const actorId = env.GITHUB_ACTOR_ID;
  if (actorId !== undefined && !/^\d+$/.test(actorId)) {
    throw new Error(
      "GITHUB_ACTOR_ID must be numeric when provided; Patchworks will not create a misleading noreply identity.",
    );
  }

  return {
    email: actorId
      ? `${actorId}+${actor}@users.noreply.github.com`
      : `${actor}@users.noreply.github.com`,
    name: actor,
  };
}

function sanitizedGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv = { ...env };

  for (const key of Object.keys(sanitizedEnv)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith("GIT_") ||
      unsafeGitEnvKeys.has(normalizedKey)
    ) {
      delete sanitizedEnv[key];
    }
  }

  return sanitizedEnv;
}

function validateIdentityValue(
  key: "user.email" | "user.name",
  value: string,
): string {
  const normalizedValue = value.trim();
  if (
    normalizedValue.length === 0 ||
    hasControlCharacters(normalizedValue) ||
    /[<>]/.test(normalizedValue)
  ) {
    throw new Error(
      `Git ${key} contains characters that cannot be used safely for commit attribution.`,
    );
  }
  return normalizedValue;
}

async function configuredGitValue(
  key: "user.email" | "user.name",
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const value = await runGit(["config", "--get", key], { cwd, env });
    return value.trim().length > 0
      ? validateIdentityValue(key, value)
      : undefined;
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 1) {
      return undefined;
    }
    throw error;
  }
}

async function resolveCommitIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<GitIdentity> {
  const actionsIdentity = githubActionsIdentity(env);
  if (actionsIdentity) {
    return actionsIdentity;
  }

  const [name, email] = await Promise.all([
    configuredGitValue("user.name", cwd, env),
    configuredGitValue("user.email", cwd, env),
  ]);
  const missing = [
    ...(name ? [] : ["user.name"]),
    ...(email ? [] : ["user.email"]),
  ];
  if (!name || !email) {
    throw new Error(
      `Git user identity is not configured (missing ${missing.join(" and ")}). Configure both values before running patchworks create:\n` +
        '  git config --global user.name "Your Name"\n' +
        '  git config --global user.email "you@example.com"',
    );
  }

  return { email, name };
}

/** Build an isolated commit environment without inheriting Git hooks or overrides. */
export async function createPatchworksCommitEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const commitEnv = sanitizedGitEnvironment(env);
  const identity = await resolveCommitIdentity(cwd, commitEnv);

  return {
    ...commitEnv,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
  };
}

export function inferRepositoryName(repoUrl: string): string {
  validateRepository(repoUrl);

  let candidate = repoUrl.replace(/[\\/]+$/, "");
  const scpSeparator = candidate.match(/^[^/]+@[^/:]+:(.+)$/)?.[1];
  if (scpSeparator) {
    candidate = scpSeparator;
  } else if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(candidate)) {
    candidate = new URL(candidate).pathname.replace(/\/+$/, "");
  }

  const name = candidate.split(/[\\/]/).at(-1)?.replace(/\.git$/, "");
  if (!name || name === "." || name === "..") {
    throw new Error(`Unable to determine a destination from '${repoUrl}'.`);
  }
  return name;
}

export function validateRepository(repoUrl: string): void {
  if (repoUrl.length === 0 || repoUrl.trim() !== repoUrl) {
    throw new Error("Template repository must be a non-empty URL or path.");
  }
  if (/^[\s-]/.test(repoUrl) || hasControlCharacters(repoUrl)) {
    throw new Error(`Invalid template repository '${repoUrl}'.`);
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(repoUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      throw new Error(`Invalid template repository URL '${repoUrl}'.`);
    }
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.username.length > 0 || parsed.password.length > 0)
    ) {
      throw new Error(
        "Template repository URLs must not contain embedded credentials.",
      );
    }
    if (parsed.password.length > 0) {
      throw new Error(
        "Template repository URLs must not contain embedded credentials.",
      );
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      throw new Error(
        "Template repository URLs must not contain a query string or fragment.",
      );
    }
  }
}

function resolveRepositoryLocation(repoUrl: string, cwd: string): string {
  const isUrl = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(repoUrl);
  const isScpLike = /^[^/\\:]+@?[^/\\:]*:.+/.test(repoUrl);
  const isWindowsPath = path.win32.isAbsolute(repoUrl);
  return isUrl || (isScpLike && !isWindowsPath)
    ? repoUrl
    : path.resolve(cwd, repoUrl);
}

async function validateBranch(branch: string, cwd: string): Promise<void> {
  if (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch === "HEAD" ||
    hasControlCharacters(branch)
  ) {
    throw new Error(`Invalid template branch '${branch}'.`);
  }

  try {
    await runGit(["check-ref-format", `refs/heads/${branch}`], { cwd });
  } catch {
    throw new Error(`Invalid template branch '${branch}'.`);
  }
}

async function detectDefaultBranch(
  repoUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const remote = await runGit(
      ["ls-remote", "--symref", "--", repoUrl, "HEAD"],
      { cwd, env },
    );
    return remote.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

type TreeEntry = {
  mode: string;
};

function parseTreeEntries(output: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const metadata = record.slice(0, tab).split(" ");
    const entryPath = record.slice(tab + 1);
    const mode = metadata[0];
    if (mode) {
      entries.set(entryPath, { mode });
    }
  }
  return entries;
}

async function assertFilesystemDirectoryOrMissing(
  directory: string,
  displayPath: string,
): Promise<void> {
  const state = await pathState(directory);
  if (!state) {
    return;
  }
  if (state.isSymbolicLink()) {
    throw new Error(
      `Template path '${displayPath}' is a symbolic link; Patchworks will not write through it.`,
    );
  }
  if (!state.isDirectory()) {
    throw new Error(
      `Template path '${displayPath}' must be a directory for Patchworks setup.`,
    );
  }
}

async function assertControlPathsAvailable(
  repository: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const output = await runGit(
    [
      "ls-tree",
      "-z",
      "HEAD",
      "--",
      CONFIG_PATH,
      ".github",
      ".github/workflows",
      WORKFLOW_PATH,
    ],
    { cwd: repository, env },
  );
  const entries = parseTreeEntries(output);

  if (entries.has(CONFIG_PATH)) {
    throw new Error(
      `Template already contains '${CONFIG_PATH}'; refusing to overwrite it.`,
    );
  }
  if (entries.has(WORKFLOW_PATH)) {
    throw new Error(
      `Template already contains '${WORKFLOW_PATH}'; refusing to overwrite it.`,
    );
  }

  for (const directory of [".github", ".github/workflows"] as const) {
    const entry = entries.get(directory);
    if (entry && entry.mode !== "040000") {
      throw new Error(
        `Template path '${directory}' is not a directory; refusing to write through it.`,
      );
    }
    await assertFilesystemDirectoryOrMissing(
      path.join(repository, directory),
      directory,
    );
  }

  if (await pathState(path.join(repository, CONFIG_PATH))) {
    throw new Error(
      `Template already contains '${CONFIG_PATH}'; refusing to overwrite it.`,
    );
  }
  if (await pathState(path.join(repository, WORKFLOW_PATH))) {
    throw new Error(
      `Template already contains '${WORKFLOW_PATH}'; refusing to overwrite it.`,
    );
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  const state = await pathState(directory);
  if (state) {
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error(`Refusing to write through '${directory}'.`);
    }
    return;
  }

  try {
    await mkdir(directory);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error;
    }
    const racedState = await pathState(directory);
    if (!racedState || racedState.isSymbolicLink() || !racedState.isDirectory()) {
      throw new Error(`Refusing to write through '${directory}'.`);
    }
  }
}

async function writeNewFile(filePath: string, contents: string): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o644,
  );
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

async function addControlBlob(
  repository: string,
  relativePath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const object = await runGit(
    ["hash-object", "-w", "--no-filters", "--", relativePath],
    { cwd: repository, env },
  );
  await runGit(
    ["update-index", "--add", "--cacheinfo", `100644,${object},${relativePath}`],
    { cwd: repository, env },
  );
}

export function buildPatchworksWorkflow(actionVersion: string): string {
  return `name: Patchworks

on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * *"

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: patchworks-\${{ github.repository }}
  cancel-in-progress: false

jobs:
  patchworks:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      # Use a GitHub App token or fine-grained PAT as PATCHWORKS_TOKEN when:
      # - the template is private and cross-repository (template Contents read),
      # - updates may change .github/workflows (Workflows write access), or
      # - Patchworks pull requests must trigger normal CI without approval
      #   (GITHUB_TOKEN-created runs are approval-gated).
      # The token also needs Contents and Pull requests write on this repository.
      - name: Update from template
        uses: ludicroushq/patchworks@v${actionVersion}
        with:
          token: \${{ secrets.PATCHWORKS_TOKEN }}
`;
}

async function inspectDestination(destination: string): Promise<boolean> {
  const state = await pathState(destination);
  if (!state) {
    return false;
  }
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`Destination '${destination}' already exists.`);
  }
  if ((await readdir(destination)).length > 0) {
    throw new Error(
      `Destination '${destination}' already exists and is not empty.`,
    );
  }
  return true;
}

async function promoteRepository(
  stagingDirectory: string,
  destination: string,
  destinationExisted: boolean,
): Promise<void> {
  const currentState = await pathState(destination);
  if (destinationExisted) {
    if (
      !currentState ||
      currentState.isSymbolicLink() ||
      !currentState.isDirectory() ||
      (await readdir(destination)).length > 0
    ) {
      throw new Error(`Destination '${destination}' changed while creating it.`);
    }
    await rmdir(destination);
    try {
      await rename(stagingDirectory, destination);
    } catch (error) {
      await mkdir(destination).catch(() => undefined);
      throw error;
    }
    return;
  }

  if (currentState) {
    throw new Error(`Destination '${destination}' was created concurrently.`);
  }
  await rename(stagingDirectory, destination);
}

export async function createRepository(
  options: CreateRepositoryOptions,
): Promise<CreateRepositoryResult> {
  validateRepository(options.repoUrl);
  const repository = resolveRepositoryLocation(options.repoUrl, process.cwd());
  const destinationInput = options.destination;
  if (
    destinationInput.length === 0 ||
    destinationInput.trim().length === 0 ||
    hasControlCharacters(destinationInput)
  ) {
    throw new Error("Destination must be a non-empty directory path.");
  }

  const destination = path.resolve(destinationInput);
  if (destination === path.parse(destination).root) {
    throw new Error("The filesystem root cannot be used as a destination.");
  }
  const parentDirectory = path.dirname(destination);
  const parentState = await stat(parentDirectory).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!parentState?.isDirectory()) {
    throw new Error(`Destination parent '${parentDirectory}' does not exist.`);
  }
  const destinationExisted = await inspectDestination(destination);
  const env = options.env ?? process.env;

  let branch: string;
  if (options.branch !== undefined) {
    branch = options.branch;
    await validateBranch(branch, parentDirectory);
  } else {
    options.onProgress?.(`Detecting the default branch for ${options.repoUrl}...`);
    const detectedBranch = await detectDefaultBranch(
      repository,
      parentDirectory,
      env,
    );
    branch = detectedBranch ?? "main";
    if (!detectedBranch) {
      options.onProgress?.(
        "Could not detect the default branch; falling back to main.",
      );
    }
    await validateBranch(branch, parentDirectory);
  }

  const commitEnv = await createPatchworksCommitEnv(process.cwd(), env);

  const stagingDirectory = await mkdtemp(
    path.join(parentDirectory, ".patchworks-create-"),
  );
  let promoted = false;

  try {
    options.onProgress?.(
      `Cloning ${options.repoUrl} (branch: ${branch}) into ${destination}...`,
    );
    await runGit(
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--branch",
        branch,
        "--",
        repository,
        stagingDirectory,
      ],
      { cwd: parentDirectory, env },
    );

    const templateCommit = await runGit(["rev-parse", "HEAD"], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    const templateTree = await runGit(["rev-parse", "HEAD^{tree}"], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    await assertControlPathsAvailable(stagingDirectory, commitEnv);

    const initialCommit = await runGit(
      ["commit-tree", templateTree, "-m", "Initial commit"],
      { cwd: stagingDirectory, env: commitEnv },
    );
    await runGit(["reset", "--hard", initialCommit], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    await runGit(["remote", "remove", "origin"], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    await unlink(path.join(stagingDirectory, ".git", "shallow")).catch(
      (error: unknown) => {
        if (!isErrnoException(error) || error.code !== "ENOENT") {
          throw error;
        }
      },
    );

    const config = {
      version,
      template: {
        repository,
        branch,
      },
      commit: templateCommit,
    };
    await writeNewFile(
      path.join(stagingDirectory, CONFIG_PATH),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await ensureRealDirectory(path.join(stagingDirectory, ".github"));
    await ensureRealDirectory(
      path.join(stagingDirectory, ".github", "workflows"),
    );
    await writeNewFile(
      path.join(stagingDirectory, WORKFLOW_PATH),
      buildPatchworksWorkflow(version),
    );

    await addControlBlob(stagingDirectory, CONFIG_PATH, commitEnv);
    await addControlBlob(stagingDirectory, WORKFLOW_PATH, commitEnv);
    const configuredTree = await runGit(["write-tree"], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    const configuredCommit = await runGit(
      [
        "commit-tree",
        configuredTree,
        "-p",
        initialCommit,
        "-m",
        "Configure Patchworks",
      ],
      { cwd: stagingDirectory, env: commitEnv },
    );
    await runGit(["reset", "--hard", configuredCommit], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    await runGit(["reflog", "expire", "--expire=now", "--all"], {
      cwd: stagingDirectory,
      env: commitEnv,
    });
    await runGit(["gc", "--prune=now", "--quiet"], {
      cwd: stagingDirectory,
      env: commitEnv,
    });

    await promoteRepository(
      stagingDirectory,
      destination,
      destinationExisted,
    );
    promoted = true;

    return {
      branch,
      destination,
      initialCommit,
      templateCommit,
    };
  } finally {
    if (!promoted) {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  }
}
