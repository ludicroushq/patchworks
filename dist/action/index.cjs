"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/action/index.ts
var action_exports = {};
__export(action_exports, {
  applyPatchSafely: () => applyPatchSafely,
  buildPullRequestBody: () => buildPullRequestBody,
  getRefName: () => getRefName,
  parseGithubSlug: () => parseGithubSlug,
  runCommand: () => runCommand,
  runPatchworksUpdate: () => runPatchworksUpdate,
  setWorkspaceForTesting: () => setWorkspaceForTesting,
  toCommitUrl: () => toCommitUrl,
  toCompareUrl: () => toCompareUrl
});
module.exports = __toCommonJS(action_exports);
var import_node_child_process = require("child_process");
var import_node_fs = require("fs");
var import_node_os = require("os");
var import_node_path = __toESM(require("path"), 1);
var import_node_process = __toESM(require("process"), 1);
var workspace = import_node_process.default.env.GITHUB_WORKSPACE ? import_node_path.default.resolve(import_node_process.default.env.GITHUB_WORKSPACE) : import_node_process.default.cwd();
import_node_process.default.chdir(workspace);
function setWorkspaceForTesting(newWorkspace) {
  workspace = newWorkspace;
  import_node_process.default.chdir(workspace);
}
async function runCommand(command, args, options = {}) {
  const spawned = (0, import_node_child_process.spawn)(command, args, {
    cwd: workspace,
    env: import_node_process.default.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  spawned.stdout?.setEncoding("utf8");
  spawned.stderr?.setEncoding("utf8");
  spawned.stdout?.on("data", (data) => {
    stdoutChunks.push(data);
  });
  spawned.stderr?.on("data", (data) => {
    stderrChunks.push(data);
  });
  if (options.input) {
    spawned.stdin?.write(options.input);
  }
  spawned.stdin?.end();
  return new Promise((resolve, reject) => {
    spawned.on("error", (error) => {
      reject(error);
    });
    spawned.on("close", (code) => {
      const result = {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        code: code ?? 0
      };
      if (result.code !== 0 && !options.allowFailure) {
        const error = new Error(
          `Command failed: ${command} ${args.join(" ")}
${result.stderr}`
        );
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}
async function runGit(args, options = {}) {
  return runCommand("git", args, options);
}
function parseGithubSlug(repositoryUrl) {
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
function toCommitUrl(repositoryUrl, commit) {
  const slug = parseGithubSlug(repositoryUrl);
  if (!slug) {
    return null;
  }
  return `https://github.com/${slug}/commit/${commit}`;
}
function toCompareUrl(repositoryUrl, fromCommit, toCommit) {
  const slug = parseGithubSlug(repositoryUrl);
  if (!slug) {
    return null;
  }
  return `https://github.com/${slug}/compare/${fromCommit}...${toCommit}`;
}
function getRefName() {
  if (import_node_process.default.env.PATCHWORKS_BASE_BRANCH) {
    return import_node_process.default.env.PATCHWORKS_BASE_BRANCH;
  }
  if (import_node_process.default.env.GITHUB_REF_NAME) {
    return import_node_process.default.env.GITHUB_REF_NAME;
  }
  const ref = import_node_process.default.env.GITHUB_REF;
  if (ref?.startsWith("refs/heads/")) {
    return ref.replace("refs/heads/", "");
  }
  return "main";
}
async function ensureCleanWorkingTree(gitRunner) {
  const status = await gitRunner(["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    throw new Error(
      "Working tree is not clean before running Patchworks update. Please ensure the repository has no pending changes."
    );
  }
}
async function ensureGitIdentity(gitRunner) {
  const name = import_node_process.default.env.PATCHWORKS_GIT_NAME ?? "Patchworks";
  const email = import_node_process.default.env.PATCHWORKS_GIT_EMAIL ?? "bot@patchworks.dev";
  await gitRunner(["config", "user.name", name]);
  await gitRunner(["config", "user.email", email]);
}
async function readConfig(configPath) {
  if (!(0, import_node_fs.existsSync)(configPath)) {
    throw new Error(
      `.patchworks.json not found at ${configPath}. Cannot continue.`
    );
  }
  const raw = await import_node_fs.promises.readFile(configPath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.commit || typeof parsed.commit !== "string") {
      throw new Error("Missing commit in patchworks config");
    }
    if (!parsed.template?.repository) {
      throw new Error("Missing template.repository in patchworks config");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Unable to parse .patchworks.json. Ensure it is valid JSON. ${error.message}`
    );
  }
}
async function fetchTemplate(gitRunner, remoteName, repository, branch) {
  await gitRunner(["remote", "remove", remoteName], { allowFailure: true });
  await gitRunner(["remote", "add", remoteName, repository]);
  await gitRunner([
    "fetch",
    "--no-tags",
    "--force",
    "--prune",
    remoteName,
    branch
  ]);
}
async function getTemplateCommits(gitRunner, remoteName, branch) {
  const revList = await gitRunner(["rev-list", `${remoteName}/${branch}`]);
  return revList.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}
async function getCommitSubject(gitRunner, commit) {
  const subject = await gitRunner([
    "show",
    "--no-patch",
    "--pretty=format:%s",
    commit
  ]);
  return subject.stdout.trim();
}
async function applyPatchSafely(patchFile, gitRunner) {
  const strategies = [
    ["--reject", "--whitespace=nowarn", patchFile],
    ["--reject", "--whitespace=fix", patchFile],
    ["--reject", "--ignore-space-change", "--whitespace=nowarn", patchFile],
    ["--reject", "--ignore-whitespace", "--whitespace=nowarn", patchFile]
  ];
  for (const args of strategies) {
    const result = await gitRunner(["apply", ...args], { allowFailure: true });
    if (result.code === 0) {
      return;
    }
    const status = await gitRunner(["status", "--porcelain"]);
    if (status.stdout.trim().length > 0) {
      console.log(
        "Patch applied with warnings. Some hunks may have been rejected (see .rej files if present)."
      );
      return;
    }
  }
  throw new Error(
    "Failed to apply template diff. Manual intervention required."
  );
}
async function createPullRequest(token, owner, repo, title, head, base, body) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "patchworks-action"
      },
      body: JSON.stringify({
        title,
        head,
        base,
        body
      })
    }
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create pull request (${response.status}): ${errorText}`
    );
  }
  const pr = await response.json();
  console.log(`Created PR #${pr.number}: ${pr.html_url}`);
}
async function checkExistingPullRequest(token, owner, repo, head) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${head}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "patchworks-action"
      }
    }
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to check for existing pull requests (${response.status}): ${errorText}`
    );
  }
  const prs = await response.json();
  const existing = prs[0];
  if (existing) {
    console.log(
      `Found existing Patchworks update PR (#${existing.number}). Exiting without changes.`
    );
    return true;
  }
  return false;
}
function buildPullRequestBody(input) {
  const {
    templateRepo,
    templateBranch,
    currentCommit,
    nextCommit,
    commitSubject,
    compareUrl,
    commitUrl,
    rejectFiles
  } = input;
  const lines = [];
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
var defaultDependencies = {
  gitRunner: runGit,
  createPullRequest,
  checkExistingPullRequest
};
async function runPatchworksUpdate(overrides = {}) {
  const { gitRunner, createPullRequest: createPullRequest2, checkExistingPullRequest: checkExistingPullRequest2 } = {
    ...defaultDependencies,
    ...overrides
  };
  console.log(`Running Patchworks update from ${workspace}`);
  const configPath = import_node_path.default.join(workspace, ".patchworks.json");
  const config = await readConfig(configPath);
  const templateBranch = config.template.branch ?? "main";
  const templateRepo = config.template.repository;
  const currentTemplateCommit = config.commit;
  const baseBranch = getRefName();
  console.log(`Using base branch ${baseBranch}`);
  const githubRepo = import_node_process.default.env.GITHUB_REPOSITORY;
  if (!githubRepo) {
    throw new Error("GITHUB_REPOSITORY is not set in the environment");
  }
  const [owner, repo] = githubRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Unable to parse owner/repo from ${githubRepo}`);
  }
  const token = import_node_process.default.env.GITHUB_TOKEN || import_node_process.default.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN (or GH_TOKEN) is required to create pull requests"
    );
  }
  const updateBranch = import_node_process.default.env.PATCHWORKS_BRANCH_NAME ?? "patchworks/update";
  const hasExistingPR = await checkExistingPullRequest2(
    token,
    owner,
    repo,
    updateBranch
  );
  if (hasExistingPR) {
    return;
  }
  await ensureCleanWorkingTree(gitRunner);
  await ensureGitIdentity(gitRunner);
  await gitRunner(["fetch", "origin", baseBranch]);
  await gitRunner(["checkout", baseBranch]);
  await gitRunner(["pull", "--ff-only", "origin", baseBranch]);
  await fetchTemplate(
    gitRunner,
    "patchworks-template",
    templateRepo,
    templateBranch
  );
  const templateCommits = await getTemplateCommits(
    gitRunner,
    "patchworks-template",
    templateBranch
  );
  if (templateCommits.length === 0) {
    console.log("No commits found on template branch. Nothing to do.");
    return;
  }
  const indexOfCurrent = templateCommits.indexOf(currentTemplateCommit);
  if (indexOfCurrent === -1) {
    throw new Error(
      `Current template commit ${currentTemplateCommit} not found on branch ${templateBranch}. Template history may have been rewritten.`
    );
  }
  if (indexOfCurrent === 0) {
    console.log("Repository already matches the latest template commit.");
    return;
  }
  const nextTemplateCommit = templateCommits[indexOfCurrent - 1];
  if (!nextTemplateCommit) {
    throw new Error(
      `Unable to determine the next template commit after ${currentTemplateCommit}.`
    );
  }
  const shortNext = nextTemplateCommit.substring(0, 7);
  const shortCurrent = currentTemplateCommit.substring(0, 7);
  console.log(
    `Preparing update for template commit ${shortCurrent} -> ${shortNext}`
  );
  await gitRunner(["checkout", "-B", updateBranch, baseBranch]);
  const diffResult = await gitRunner([
    "diff",
    "--binary",
    "--find-renames",
    `${currentTemplateCommit}`,
    `${nextTemplateCommit}`
  ]);
  const diffContent = diffResult.stdout;
  if (diffContent.trim().length === 0) {
    console.log(
      "Template diff is empty. Repository already matches template changes."
    );
  } else {
    const tempDir = await import_node_fs.promises.mkdtemp(import_node_path.default.join((0, import_node_os.tmpdir)(), "patchworks-"));
    const patchFile = import_node_path.default.join(tempDir, `${nextTemplateCommit}.patch`);
    await import_node_fs.promises.writeFile(patchFile, diffContent, "utf8");
    await applyPatchSafely(patchFile, gitRunner);
    await import_node_fs.promises.rm(patchFile, { force: true });
    await import_node_fs.promises.rm(tempDir, { recursive: true, force: true });
  }
  const updatedConfig = {
    ...config,
    commit: nextTemplateCommit
  };
  await import_node_fs.promises.writeFile(
    configPath,
    `${JSON.stringify(updatedConfig, null, 2)}
`,
    "utf8"
  );
  await gitRunner(["add", "-A"]);
  const staged = await gitRunner(["diff", "--name-only", "--cached"]);
  if (staged.stdout.trim().length === 0) {
    console.log(
      "No changes to commit after applying template update. Exiting."
    );
    return;
  }
  const stagedFiles = staged.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const rejectFiles = stagedFiles.filter((file) => file.endsWith(".rej"));
  const commitMessage = `Patchworks: sync ${shortCurrent} -> ${shortNext}`;
  await gitRunner(["commit", "-m", commitMessage]);
  await gitRunner(["push", "--force-with-lease", "origin", updateBranch]);
  const commitSubject = await getCommitSubject(gitRunner, nextTemplateCommit);
  const commitUrl = toCommitUrl(templateRepo, nextTemplateCommit);
  const compareUrl = toCompareUrl(
    templateRepo,
    currentTemplateCommit,
    nextTemplateCommit
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
    rejectFiles
  });
  await createPullRequest2(
    token,
    owner,
    repo,
    prTitle,
    updateBranch,
    baseBranch,
    prBody
  );
  console.log("Patchworks update completed successfully.");
}
var isTestEnvironment = import_node_process.default.env.VITEST === "true" || import_node_process.default.env.NODE_ENV === "test";
if (!isTestEnvironment) {
  runPatchworksUpdate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && "stack" in error) {
      console.error(error.stack);
    }
    import_node_process.default.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyPatchSafely,
  buildPullRequestBody,
  getRefName,
  parseGithubSlug,
  runCommand,
  runPatchworksUpdate,
  setWorkspaceForTesting,
  toCommitUrl,
  toCompareUrl
});
//# sourceMappingURL=index.cjs.map