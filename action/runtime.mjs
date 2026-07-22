import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const WORKFLOW_PREFIX = ".github/workflows/";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const MAX_CONFIG_BYTES = 1024 * 1024;

function cleanApiErrorBody(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.message === "string" ? parsed.message : "unknown error";
  } catch {
    return "unknown error";
  }
}

function escapeAnnotation(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function displayPath(file) {
  return JSON.stringify(String(file)).slice(1, -1).replaceAll("`", "\\`");
}

function normalizeRepository(repository) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository);
  if (!match) {
    throw new Error(`Invalid GitHub repository identifier: ${repository}`);
  }
  return { owner: match[1], name: match[2] };
}

function apiEndpoint(apiUrl, relativePath) {
  const base = new URL(apiUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  base.search = "";
  base.hash = "";
  return new URL(relativePath.replace(/^\/+/, ""), base);
}

function apiErrorStatus(error) {
  return error && typeof error === "object" ? error.status : undefined;
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function permissionCheck(customToken) {
  return customToken ? "custom-token" : "not-verifiable";
}

function blockedPreflight(message, customToken) {
  return {
    blocked: true,
    message,
    outputs: {
      permission_check: permissionCheck(customToken),
      pull_request_url: "",
      skip: "false",
      status: "blocked",
    },
  };
}

function defaultTokenWarning() {
  return (
    "Patchworks is using GITHUB_TOKEN. GitHub does not grant this token the Administration permission needed to verify whether Actions may create pull requests. " +
    "Before relying on automation, enable Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create and approve pull requests. " +
    "Pull requests created with GITHUB_TOKEN do not trigger normal unattended CI; use a GitHub App installation token or personal access token when checks must start automatically."
  );
}

function branchSha(value) {
  const sha = value?.object?.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha)
    ? sha.toLowerCase()
    : null;
}

function newestMergedPullRequest(pulls) {
  let newest = null;
  let newestTime = Number.NEGATIVE_INFINITY;

  for (const pull of pulls) {
    const mergedAt = typeof pull?.merged_at === "string" ? pull.merged_at : "";
    const headSha = pull?.head?.sha;
    const mergedTime = Date.parse(mergedAt);
    if (
      Number.isFinite(mergedTime) &&
      typeof headSha === "string" &&
      /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(headSha) &&
      mergedTime > newestTime
    ) {
      newest = { headSha: headSha.toLowerCase() };
      newestTime = mergedTime;
    }
  }

  return newest;
}

function safeJsonArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string");
}

function reportValue(report, camelCase, snakeCase) {
  return report[camelCase] ?? report[snakeCase];
}

function isRejectArtifact(file) {
  return (
    file.endsWith(".rej") ||
    (file.startsWith(".patchworks-rejects/") && file.endsWith(".patch"))
  );
}

function parseGitStatus(output) {
  const records = output.split("\0");
  const files = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Unable to parse git status output safely");
    }

    const status = record.slice(0, 2);
    files.push(record.slice(3));

    if (status.includes("R") || status.includes("C")) {
      const source = records[index + 1];
      if (!source) {
        throw new Error("Git reported a rename or copy without a source path");
      }
      files.push(source);
      index += 1;
    }
  }

  return [...new Set(files)].sort();
}

function replaceRejectSection(body, rejectFiles, hadConflicts = false) {
  const rejects =
    rejectFiles.length === 0
      ? hadConflicts
        ? "- Conflicts reported; no reject artifact paths were available."
        : "- None"
      : rejectFiles.map((file) => `- \`${displayPath(file)}\``).join("\n");
  const section = `## Rejects\n\n${rejects}`;
  const existing = /(^|\n)## Rejects\s*\n[\s\S]*?(?=\n## |$)/;

  if (existing.test(body)) {
    return body.replace(existing, (match, prefix) => `${prefix}${section}`);
  }

  return `${body.trim()}${body.trim() ? "\n\n" : ""}${section}`;
}

async function requestJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body = await response.text();

  if (!response.ok) {
    const error = new Error(
      `GitHub API request failed (${response.status}): ${cleanApiErrorBody(body)}`,
    );
    error.status = response.status;
    throw error;
  }

  return body ? JSON.parse(body) : null;
}

export function createDelimiter(value, uuid = randomUUID) {
  let delimiter;
  do {
    delimiter = `patchworks_${uuid().replaceAll("-", "")}`;
  } while (String(value).split(/\r?\n/).includes(delimiter));
  return delimiter;
}

export function writeCommandFile(file, entries, uuid = randomUUID) {
  if (!file) throw new Error("GitHub command file path is not available");

  for (const [name, rawValue] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid GitHub output name: ${name}`);
    }
    const value = String(rawValue ?? "");
    const delimiter = createDelimiter(value, uuid);
    appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
  }
}

export function writeError(message) {
  console.error(`::error title=Patchworks::${escapeAnnotation(message)}`);
}

export function writeWarning(message) {
  console.warn(`::warning title=Patchworks::${escapeAnnotation(message)}`);
}

export function appendSummary(file, markdown) {
  if (file) appendFileSync(file, `${markdown.trim()}\n`, "utf8");
}

export async function preflight({
  apiUrl,
  branch,
  customToken,
  fetchImpl = globalThis.fetch,
  repository,
  token,
}) {
  if (!token) {
    return {
      blocked: true,
      message:
        "No GitHub token is available. Grant the workflow contents: write and pull-requests: write permissions, or pass the action's token input.",
      outputs: {
        permission_check: "missing-token",
        pull_request_url: "",
        skip: "false",
        status: "blocked",
      },
    };
  }

  const { owner, name } = normalizeRepository(repository);
  const repositoryPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const pullsUrl = apiEndpoint(
    apiUrl,
    `${repositoryPath}/pulls`,
  );
  pullsUrl.searchParams.set("state", "open");
  pullsUrl.searchParams.set("head", `${owner}:${branch}`);
  pullsUrl.searchParams.set("per_page", "1");

  let pulls;
  try {
    pulls = await requestJson(pullsUrl, token, fetchImpl);
  } catch (error) {
    return {
      blocked: true,
      message:
        "Patchworks could not check for an existing update pull request. It stopped before checkout so it would not overwrite human conflict resolutions. " +
        (error instanceof Error ? error.message : String(error)),
      outputs: {
        permission_check: "unknown",
        pull_request_url: "",
        skip: "false",
        status: "blocked",
      },
    };
  }

  if (!Array.isArray(pulls)) {
    throw new Error("GitHub returned an invalid pull request response");
  }

  if (pulls.length > 0) {
    const url = typeof pulls[0]?.html_url === "string" ? pulls[0].html_url : "";
    return {
      blocked: false,
      message: url
        ? `An open Patchworks pull request already exists: ${url}`
        : "An open Patchworks pull request already exists.",
      outputs: {
        permission_check: customToken ? "custom-token" : "not-needed",
        pull_request_url: url,
        skip: "true",
        status: "pull-request-open",
      },
    };
  }

  const branchUrl = apiEndpoint(
    apiUrl,
    `${repositoryPath}/git/ref/heads/${encodePath(branch)}`,
  );
  let existingBranchSha = null;

  try {
    existingBranchSha = branchSha(
      await requestJson(branchUrl, token, fetchImpl),
    );
    if (!existingBranchSha) {
      return blockedPreflight(
        `GitHub returned invalid metadata for the existing update branch ${JSON.stringify(branch)}. Patchworks stopped before checkout to preserve that branch.`,
        customToken,
      );
    }
  } catch (error) {
    if (apiErrorStatus(error) !== 404) {
      return blockedPreflight(
        `Patchworks could not determine whether update branch ${JSON.stringify(branch)} already exists. It stopped before checkout to preserve any orphaned or human commits. ${error instanceof Error ? error.message : String(error)}`,
        customToken,
      );
    }
  }

  if (existingBranchSha) {
    const closedPullsUrl = apiEndpoint(apiUrl, `${repositoryPath}/pulls`);
    closedPullsUrl.searchParams.set("state", "closed");
    closedPullsUrl.searchParams.set("head", `${owner}:${branch}`);
    closedPullsUrl.searchParams.set("sort", "updated");
    closedPullsUrl.searchParams.set("direction", "desc");
    closedPullsUrl.searchParams.set("per_page", "100");

    let closedPulls;
    try {
      closedPulls = await requestJson(closedPullsUrl, token, fetchImpl);
    } catch (error) {
      return blockedPreflight(
        `Patchworks found update branch ${JSON.stringify(branch)} without an open pull request, but could not verify its merged pull-request history. It stopped before checkout to preserve the branch. ${error instanceof Error ? error.message : String(error)}`,
        customToken,
      );
    }

    if (!Array.isArray(closedPulls)) {
      return blockedPreflight(
        `GitHub returned invalid pull-request history for update branch ${JSON.stringify(branch)}. Patchworks stopped before checkout to preserve the branch.`,
        customToken,
      );
    }

    const newestMerged = newestMergedPullRequest(closedPulls);
    if (!newestMerged || newestMerged.headSha !== existingBranchSha) {
      const expected = newestMerged
        ? ` The newest merged pull request ended at ${newestMerged.headSha}, while the branch is at ${existingBranchSha}.`
        : " No merged pull request for this branch was found.";
      return blockedPreflight(
        `Update branch ${JSON.stringify(branch)} exists without an open pull request, and Patchworks cannot prove it is an untouched branch left by the newest merged pull request.${expected} Inspect, rename, or delete the branch deliberately before retrying; Patchworks will not overwrite possible orphaned or human commits.`,
        customToken,
      );
    }
  }

  return {
    blocked: false,
    ...(customToken ? {} : { message: defaultTokenWarning() }),
    outputs: {
      permission_check: permissionCheck(customToken),
      pull_request_url: "",
      skip: "false",
      status: "ready",
    },
  };
}

function readTemplateRepository(workspace) {
  try {
    const configPath = join(workspace, ".patchworks.json");
    const configState = lstatSync(configPath);
    if (
      configState.isSymbolicLink() ||
      !configState.isFile() ||
      configState.size > MAX_CONFIG_BYTES
    ) {
      return "";
    }
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof config?.template?.repository === "string"
      ? config.template.repository
      : "";
  } catch {
    return "";
  }
}

function templateAuthentication(repository, serverUrl, token) {
  if (!repository || !token) return [];

  let server;
  try {
    server = new URL(serverUrl);
  } catch {
    return [];
  }
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password
  ) {
    return [];
  }

  const serverHost = server.host.toLowerCase();
  const serverHostname = server.hostname.toLowerCase();
  let rewriteFrom = "";
  let authenticated = false;

  try {
    const repositoryUrl = new URL(repository);
    if (
      repositoryUrl.protocol === "https:" &&
      !repositoryUrl.username &&
      !repositoryUrl.password &&
      repositoryUrl.host.toLowerCase() === serverHost
    ) {
      authenticated = true;
    } else if (
      repositoryUrl.protocol === "ssh:" &&
      repositoryUrl.username === "git" &&
      !repositoryUrl.password &&
      repositoryUrl.hostname.toLowerCase() === serverHostname
    ) {
      const match = /^ssh:\/\/git@[^/]+\//i.exec(repository);
      if (match) {
        authenticated = true;
        rewriteFrom = match[0];
      }
    }
  } catch {
    const match = /^git@([^:]+):/.exec(repository);
    if (match?.[1]?.toLowerCase() === serverHostname) {
      authenticated = true;
      rewriteFrom = match[0];
    }
  }

  if (!authenticated) return [];

  const serverOrigin = server.origin;
  const authentication = Buffer.from(`x-access-token:${token}`).toString(
    "base64",
  );
  return [
    [
      `http.${serverOrigin}/.extraheader`,
      `AUTHORIZATION: basic ${authentication}`,
    ],
    ...(rewriteFrom
      ? [[`url.${serverOrigin}/.insteadOf`, rewriteFrom]]
      : []),
  ];
}

function appendGitConfig(env, entries) {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const startIndex = Number.isFinite(count) && count >= 0 ? count : 0;
  entries.forEach(([key, value], offset) => {
    const index = startIndex + offset;
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (entries.length > 0) {
    env.GIT_CONFIG_COUNT = String(startIndex + entries.length);
  }
}

export function resolvePackageSpec(actionPath, requestedSpec) {
  if (requestedSpec) {
    const hasControlCharacter = [...requestedSpec].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    });
    if (
      requestedSpec.length > 2_048 ||
      /^[\s-]/.test(requestedSpec) ||
      hasControlCharacter
    ) {
      throw new Error("patchworks-package must be a single safe npm package spec");
    }
    return requestedSpec;
  }

  const manifestPath = join(actionPath, "packages", "patchworks", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "patchworks" || typeof manifest.version !== "string") {
    throw new Error(`Invalid Patchworks package manifest at ${manifestPath}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`Invalid Patchworks package version: ${manifest.version}`);
  }
  return `patchworks@${manifest.version}`;
}

export function runUpdate({
  actionPath,
  githubOutput,
  packageSpec,
  serverUrl = "https://github.com",
  spawn = spawnSync,
  token,
  workspace,
}) {
  const resolvedPackage = resolvePackageSpec(actionPath, packageSpec);
  const reportDirectory = mkdtempSync(join(tmpdir(), "patchworks-action-"));
  const reportPath = join(reportDirectory, "report.json");
  writeCommandFile(githubOutput, { report_path: reportPath });

  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_registry: NPM_REGISTRY,
    npm_config_update_notifier: "false",
  };
  delete env.GITHUB_TOKEN;
  delete env.PATCHWORKS_TOKEN;

  appendGitConfig(
    env,
    templateAuthentication(
      readTemplateRepository(workspace),
      serverUrl,
      token,
    ),
  );

  const result = spawn(
    "npm",
    [
      "exec",
      `--registry=${NPM_REGISTRY}`,
      "--yes",
      `--package=${resolvedPackage}`,
      "--",
      "patchworks",
      "update",
      "--report",
      reportPath,
    ],
    { cwd: reportDirectory, env, stdio: "inherit" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Patchworks CLI exited with status ${result.status ?? "unknown"}`);
  }

  return { reportPath, resolvedPackage };
}

export function readChangedPaths(workspace, spawn = spawnSync) {
  const result = spawn(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: workspace, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git status failed with status ${result.status ?? "unknown"}`);
  }
  return parseGitStatus(result.stdout ?? "");
}

export function collectReport({ reportPath, workspace, spawn = spawnSync }) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Patchworks did not produce a valid report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Patchworks report must be a JSON object");
  }

  const changedFiles = readChangedPaths(workspace, spawn);
  const engineStatusValue = reportValue(report, "status", "status");
  const engineStatus =
    typeof engineStatusValue === "string" ? engineStatusValue : "";
  const reportedRejectFiles = safeJsonArray(
    reportValue(report, "rejectFiles", "reject_files"),
  ).filter(isRejectArtifact);
  const rejectFiles = [
    ...new Set([
      ...changedFiles.filter(isRejectArtifact),
      ...reportedRejectFiles,
    ]),
  ].sort();
  const reportedHadConflicts =
    reportValue(report, "hadConflicts", "had_conflicts") === true;
  const hadConflicts =
    reportedHadConflicts ||
    engineStatus === "conflicts" ||
    rejectFiles.length > 0;
  const workflowFiles = changedFiles.filter(
    (file) =>
      file.startsWith(WORKFLOW_PREFIX) && /\.ya?ml$/i.test(basename(file)),
  );
  const reportedHasChanges =
    reportValue(report, "hasChanges", "has_changes") === true;
  const hasChanges =
    changedFiles.length > 0 || reportedHasChanges || hadConflicts;
  const status = hadConflicts
    ? "conflicts"
    : hasChanges
      ? "updates-ready"
      : "up-to-date";

  const rawBody = reportValue(report, "prBody", "pr_body");
  const prBody = replaceRejectSection(
    typeof rawBody === "string" ? rawBody : "",
    rejectFiles,
    hadConflicts,
  );

  const commitMessage = reportValue(report, "commitMessage", "commit_message");
  const prTitle = reportValue(report, "prTitle", "pr_title");
  if (hasChanges && (typeof commitMessage !== "string" || !commitMessage.trim())) {
    throw new Error("Patchworks report is missing commitMessage");
  }
  if (hasChanges && (typeof prTitle !== "string" || !prTitle.trim())) {
    throw new Error("Patchworks report is missing prTitle");
  }

  return {
    changedFiles,
    report,
    summary: [
      "### Patchworks update",
      "",
      `- Status: **${status}**`,
      `- Changed files: ${changedFiles.length}`,
      `- Reject artifacts: ${rejectFiles.length}`,
      `- Workflow files: ${workflowFiles.length}`,
      ...(hadConflicts
        ? [
            "",
            rejectFiles.length > 0
              ? "Resolve and remove every legacy `.rej` file and the current `.patchworks-rejects/<commit>/` artifact tree before merging."
              : "Patchworks reported conflicts, but no reject artifact paths were available. Inspect the update before merging.",
          ]
        : []),
    ].join("\n"),
    outputs: {
      commit_message: typeof commitMessage === "string" ? commitMessage : "",
      current_commit: String(
        reportValue(report, "currentCommit", "current_commit") ?? "",
      ),
      engine_status: engineStatus,
      has_changes: hasChanges ? "true" : "false",
      has_rejects: rejectFiles.length > 0 ? "true" : "false",
      had_conflicts: hadConflicts ? "true" : "false",
      next_commit: String(reportValue(report, "nextCommit", "next_commit") ?? ""),
      pr_body: prBody,
      pr_title: typeof prTitle === "string" ? prTitle : "",
      reject_files: rejectFiles.join("\n"),
      reject_files_json: JSON.stringify(rejectFiles),
      status,
      workflow_changes: workflowFiles.length > 0 ? "true" : "false",
      workflow_files: workflowFiles.join("\n"),
      workflow_files_json: JSON.stringify(workflowFiles),
    },
  };
}

export function guardWorkflowChanges({ customToken, workflowFiles }) {
  if (!customToken && workflowFiles.length > 0) {
    const listedFiles = workflowFiles
      .map((file) => `- ${displayPath(file)}`)
      .join("\n");
    return {
      blocked: true,
      message:
        "This update changes GitHub Actions workflow files, which GITHUB_TOKEN cannot push. Pass a GitHub App token or fine-grained PAT through the Patchworks action's token input with Contents, Pull requests, and Workflows write access. Changed workflow files:\n" +
        listedFiles,
    };
  }
  return { blocked: false };
}

export function parseWorkflowFiles(value) {
  const parsed = JSON.parse(value || "[]");
  return safeJsonArray(parsed);
}
