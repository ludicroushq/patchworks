import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

type RunOptions = {
  allowFailure?: boolean;
  input?: string;
};

export type GitRunner = (
  args: string[],
  options?: RunOptions,
) => Promise<CommandResult>;

type PatchworksConfig = {
  commit: string;
  template: {
    repository: string;
    branch?: string;
  };
  version?: string;
  [key: string]: unknown;
};

let workspace = process.env.GITHUB_WORKSPACE
  ? path.resolve(process.env.GITHUB_WORKSPACE)
  : process.cwd();
process.chdir(workspace);

export function setWorkspaceForTesting(newWorkspace: string) {
  workspace = newWorkspace;
  process.chdir(workspace);
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const spawned = spawn(command, args, {
    cwd: workspace,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  spawned.stdout?.setEncoding("utf8");
  spawned.stderr?.setEncoding("utf8");

  spawned.stdout?.on("data", (data: string) => {
    stdoutChunks.push(data);
  });

  spawned.stderr?.on("data", (data: string) => {
    stderrChunks.push(data);
  });

  if (options.input) {
    spawned.stdin?.write(options.input);
  }

  spawned.stdin?.end();

  return new Promise<CommandResult>((resolve, reject) => {
    spawned.on("error", (error) => {
      reject(error);
    });

    spawned.on("close", (code) => {
      const result: CommandResult = {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        code: code ?? 0,
      };

      if (result.code !== 0 && !options.allowFailure) {
        const error = new Error(
          `Command failed: ${command} ${args.join(" ")}\n${result.stderr}`,
        );
        (error as Error & { result?: CommandResult }).result = result;
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

async function runGit(args: string[], options: RunOptions = {}) {
  return runCommand("git", args, options);
}

export function parseGithubSlug(repositoryUrl: string): string | null {
  const cleaned = repositoryUrl.replace(/\.git$/, "").replace(/\/+$/, "");

  if (cleaned.startsWith("git@github.com:")) {
    return cleaned.replace("git@github.com:", "");
  }

  const httpsMatch = cleaned.match(/https:\/\/github.com\/(.+)/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  return null;
}

export function toCommitUrl(
  repositoryUrl: string,
  commit: string,
): string | null {
  const slug = parseGithubSlug(repositoryUrl);
  if (!slug) {
    return null;
  }
  return `https://github.com/${slug}/commit/${commit}`;
}

export function toCompareUrl(
  repositoryUrl: string,
  fromCommit: string,
  toCommit: string,
): string | null {
  const slug = parseGithubSlug(repositoryUrl);
  if (!slug) {
    return null;
  }
  return `https://github.com/${slug}/compare/${fromCommit}...${toCommit}`;
}

export function getRefName(): string {
  if (process.env.PATCHWORKS_BASE_BRANCH) {
    return process.env.PATCHWORKS_BASE_BRANCH;
  }

  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  const ref = process.env.GITHUB_REF;
  if (ref?.startsWith("refs/heads/")) {
    return ref.replace("refs/heads/", "");
  }

  return "main";
}

async function readConfig(configPath: string): Promise<PatchworksConfig> {
  if (!existsSync(configPath)) {
    throw new Error(
      `.patchworks.json not found at ${configPath}. Cannot continue.`,
    );
  }

  const raw = await fs.readFile(configPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as PatchworksConfig;
    if (!parsed.commit || typeof parsed.commit !== "string") {
      throw new Error("Missing commit in patchworks config");
    }
    if (!parsed.template?.repository) {
      throw new Error("Missing template.repository in patchworks config");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Unable to parse .patchworks.json. Ensure it is valid JSON. ${(error as Error).message}`,
    );
  }
}

async function fetchTemplate(
  gitRunner: GitRunner,
  remoteName: string,
  repository: string,
  branch: string,
) {
  await gitRunner(["remote", "remove", remoteName], { allowFailure: true });
  await gitRunner(["remote", "add", remoteName, repository]);
  await gitRunner([
    "fetch",
    "--no-tags",
    "--force",
    "--prune",
    remoteName,
    branch,
  ]);
}

async function getTemplateCommits(
  gitRunner: GitRunner,
  remoteName: string,
  branch: string,
): Promise<string[]> {
  const revList = await gitRunner(["rev-list", `${remoteName}/${branch}`]);
  return revList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function getCommitSubject(
  gitRunner: GitRunner,
  commit: string,
): Promise<string> {
  const subject = await gitRunner([
    "show",
    "--no-patch",
    "--pretty=format:%s",
    commit,
  ]);
  return subject.stdout.trim();
}

export async function applyPatchSafely(
  patchFile: string,
  gitRunner: GitRunner,
  log: (...args: unknown[]) => void = console.log,
) {
  const strategies: string[][] = [
    [
      "--reject",
      "--whitespace=fix",
      "--ignore-space-change",
      "--ignore-whitespace",
      "--inaccurate-eof",
      patchFile,
    ],
    [
      "--reject",
      "--whitespace=fix",
      "--ignore-space-change",
      "--inaccurate-eof",
      patchFile,
    ],
    [
      "--reject",
      "--whitespace=fix",
      "--ignore-whitespace",
      "--inaccurate-eof",
      patchFile,
    ],
    [
      "--reject",
      "--whitespace=nowarn",
      "--ignore-space-change",
      "--ignore-whitespace",
      "--inaccurate-eof",
      patchFile,
    ],
  ];

  for (const args of strategies) {
    const result = await gitRunner(["apply", ...args], { allowFailure: true });
    if (result.code === 0) {
      return;
    }

    const status = await gitRunner(["status", "--porcelain"]);
    if (status.stdout.trim().length > 0) {
      log(
        "Patch applied with warnings. Some hunks may have been rejected (see .rej files if present).",
      );
      return;
    }
  }

  throw new Error(
    "Failed to apply template diff. Manual intervention required.",
  );
}

export type BuildPullRequestBodyInput = {
  templateRepo: string;
  templateBranch: string;
  currentCommit: string;
  nextCommit: string;
  commitSubject: string;
  compareUrl?: string | null;
  commitUrl?: string | null;
  rejectFiles: string[];
};

export function buildPullRequestBody(input: BuildPullRequestBodyInput): string {
  const {
    templateRepo,
    templateBranch,
    currentCommit,
    nextCommit,
    commitSubject,
    compareUrl,
    commitUrl,
    rejectFiles,
  } = input;

  const lines: string[] = [];
  lines.push("## Summary");
  lines.push(`- Template: ${templateRepo} (branch "${templateBranch}")`);
  lines.push(`- Previous commit: ${currentCommit}`);
  lines.push(`- New commit: ${nextCommit}`);
  lines.push(`- Template message: ${commitSubject || "(no subject)"}`);
  if (compareUrl) {
    lines.push(`- Diff: ${compareUrl}`);
  } else if (commitUrl) {
    lines.push(`- Commit: ${commitUrl}`);
  }

  lines.push("\n## Rejects");
  if (rejectFiles.length === 0) {
    lines.push("- None");
  } else {
    for (const file of rejectFiles) {
      lines.push(`- \`${file}\``);
    }
  }

  return lines.join("\n");
}

type PatchworksDependencies = {
  gitRunner: GitRunner;
};

const defaultDependencies: PatchworksDependencies = {
  gitRunner: runGit,
};

export type PatchworksResult = {
  hasChanges: boolean;
  branchName: string;
  baseBranch: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  rejectFiles: string[];
  currentCommit: string;
  nextCommit: string;
};

export type PatchworksRunOptions = Partial<PatchworksDependencies> & {
  commit?: boolean;
  push?: boolean;
  createPr?: boolean;
  silent?: boolean;
};

export async function runPatchworksUpdate(
  options: PatchworksRunOptions = {},
): Promise<PatchworksResult> {
  const { silent = false, ...dependencyOverrides } = options;

  const { gitRunner } = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const log = (...args: unknown[]) => {
    if (!silent) {
      console.log(...args);
    }
  };

  log(`Running Patchworks update from ${workspace}`);

  const configPath = path.join(workspace, ".patchworks.json");
  const config = await readConfig(configPath);

  const templateBranch = config.template.branch ?? "main";
  const templateRepo = config.template.repository;
  const currentTemplateCommit = config.commit;

  const shortCurrent = currentTemplateCommit.substring(0, 7);
  log(
    `Template repository: ${templateRepo} (branch "${templateBranch}") — current commit ${shortCurrent}`,
  );

  const baseBranch = getRefName();
  log(`Using base branch ${baseBranch}`);

  const githubRepo = process.env.GITHUB_REPOSITORY;
  if (!githubRepo) {
    throw new Error("GITHUB_REPOSITORY is not set in the environment");
  }

  const [owner, repo] = githubRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Unable to parse owner/repo from ${githubRepo}`);
  }

  const updateBranch =
    process.env.PATCHWORKS_BRANCH_NAME ?? "patchworks/update";

  const result: PatchworksResult = {
    hasChanges: false,
    branchName: updateBranch,
    baseBranch,
    commitMessage: "",
    prTitle: "",
    prBody: "",
    rejectFiles: [],
    currentCommit: currentTemplateCommit,
    nextCommit: currentTemplateCommit,
  };

  const preflightStatus = await gitRunner(["status", "--short"], {
    allowFailure: true,
  });
  if (preflightStatus.stdout.trim().length > 0) {
    log(
      "Working tree is dirty. The following files differ:",
      "\n",
      preflightStatus.stdout.trim(),
    );
    throw new Error(
      "Working tree is not clean before running Patchworks update. Please ensure the repository has no pending changes.",
    );
  }

  await gitRunner(["fetch", "origin", baseBranch]);
  await gitRunner(["checkout", baseBranch]);
  await gitRunner(["pull", "--ff-only", "origin", baseBranch]);
  await gitRunner(["checkout", "-B", updateBranch, baseBranch]);

  await fetchTemplate(
    gitRunner,
    "patchworks-template",
    templateRepo,
    templateBranch,
  );

  const templateCommits = await getTemplateCommits(
    gitRunner,
    "patchworks-template",
    templateBranch,
  );

  if (templateCommits.length === 0) {
    log("No commits found on template branch. Nothing to do.");
    return result;
  }

  const indexOfCurrent = templateCommits.indexOf(currentTemplateCommit);

  if (indexOfCurrent === -1) {
    throw new Error(
      `Current template commit ${currentTemplateCommit} not found on branch ${templateBranch}. Template history may have been rewritten.`,
    );
  }

  if (indexOfCurrent === 0) {
    log("Repository already matches the latest template commit.");
    return result;
  }

  const nextTemplateCommit = templateCommits[indexOfCurrent - 1];
  if (!nextTemplateCommit) {
    throw new Error(
      `Unable to determine the next template commit after ${currentTemplateCommit}.`,
    );
  }
  const shortNext = nextTemplateCommit.substring(0, 7);

  log(`Next template commit detected: ${shortCurrent} -> ${shortNext}`);
  log("Generating template diff...");

  const diffResult = await gitRunner([
    "diff",
    "--binary",
    "--find-renames",
    `${currentTemplateCommit}`,
    `${nextTemplateCommit}`,
  ]);

  const diffContent = diffResult.stdout;

  if (diffContent.trim().length !== 0) {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), "patchworks-"));
    const patchFile = path.join(tempDir, `${nextTemplateCommit}.patch`);
    await fs.writeFile(patchFile, diffContent, "utf8");
    await applyPatchSafely(patchFile, gitRunner, log);
    await fs.rm(patchFile, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  } else {
    log("Template diff is empty. Repository already matches template changes.");
  }

  const updatedConfig: PatchworksConfig = {
    ...config,
    commit: nextTemplateCommit,
  };
  await fs.writeFile(
    configPath,
    `${JSON.stringify(updatedConfig, null, 2)}\n`,
    "utf8",
  );

  const statusResult = await gitRunner(["status", "--porcelain"]);
  const statusLines = statusResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (statusLines.length === 0) {
    log("No changes to commit after applying template update. Exiting.");
    return result;
  }

  const changedFiles = statusLines
    .map((line) => {
      if (line.length > 3 && line[0] === "R") {
        const arrowIndex = line.indexOf("->");
        const candidate =
          arrowIndex >= 0 ? line.slice(arrowIndex + 3) : line.slice(3);
        return candidate.trim();
      }
      if (line.length > 3) {
        return line.slice(3).trim();
      }
      return line.trim();
    })
    .filter((file) => file.length > 0);

  const rejectFiles = changedFiles.filter((file) => file.endsWith(".rej"));

  const commitMessage = `Patchworks: sync ${shortCurrent} -> ${shortNext}`;

  const commitSubject = await getCommitSubject(gitRunner, nextTemplateCommit);
  const commitUrl = toCommitUrl(templateRepo, nextTemplateCommit);
  const compareUrl = toCompareUrl(
    templateRepo,
    currentTemplateCommit,
    nextTemplateCommit,
  );

  const prTitle = `Patchworks update: ${shortNext}`;
  const prBody = buildPullRequestBody({
    templateRepo,
    templateBranch,
    currentCommit: currentTemplateCommit,
    nextCommit: nextTemplateCommit,
    commitSubject,
    compareUrl,
    commitUrl,
    rejectFiles,
  });

  result.hasChanges = true;
  result.commitMessage = commitMessage;
  result.prTitle = prTitle;
  result.prBody = prBody;
  result.rejectFiles = rejectFiles;
  result.nextCommit = nextTemplateCommit;

  log("Patchworks update prepared successfully.");

  return result;
}

const isTestEnvironment =
  process.env.VITEST === "true" || process.env.NODE_ENV === "test";

if (!isTestEnvironment) {
  runPatchworksUpdate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && "stack" in error) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}
