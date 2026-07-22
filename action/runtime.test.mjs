import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  appendSummary,
  collectReport,
  createDelimiter,
  guardWorkflowChanges,
  parseWorkflowFiles,
  preflight,
  readChangedPaths,
  resolvePackageSpec,
  runUpdate,
  writeCommandFile,
  writeError,
  writeWarning,
} from "./runtime.mjs";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function outputFile() {
  const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
  return join(directory, "output.txt");
}

function writeConfig(directory, repository) {
  writeFileSync(
    join(directory, ".patchworks.json"),
    JSON.stringify({
      commit: "a".repeat(40),
      template: { branch: "main", repository },
      version: "1.2.3",
    }),
  );
}

describe("GitHub command files", () => {
  it("chooses a delimiter that cannot be injected by multiline report data", () => {
    const ids = ["collision", "safe"];
    const value = "body\npatchworks_collision\nnext";
    expect(createDelimiter(value, () => ids.shift())).toBe("patchworks_safe");

    const file = outputFile();
    writeCommandFile(file, { pr_body: value }, () => "safe");
    expect(readFileSync(file, "utf8")).toBe(
      "pr_body<<patchworks_safe\nbody\npatchworks_collision\nnext\npatchworks_safe\n",
    );
  });

  it("rejects output names that could inject commands", () => {
    expect(() =>
      writeCommandFile(outputFile(), { "safe\nINJECTED": "value" }),
    ).toThrow("Invalid GitHub output name");
  });

  it("requires a command file and serializes nullish values as empty strings", () => {
    expect(() => writeCommandFile("", { safe: "value" })).toThrow(
      "GitHub command file path is not available",
    );

    const file = outputFile();
    writeCommandFile(file, { empty: null }, () => "fixed");
    expect(readFileSync(file, "utf8")).toBe(
      "empty<<patchworks_fixed\n\npatchworks_fixed\n",
    );
  });

  it("escapes annotations and appends trimmed job summaries", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeError("50%:\r\n,failed");
    writeWarning(42);

    expect(error).toHaveBeenCalledWith(
      "::error title=Patchworks::50%25%3A%0D%0A%2Cfailed",
    );
    expect(warning).toHaveBeenCalledWith("::warning title=Patchworks::42");

    const file = outputFile();
    appendSummary(file, "  ### Result  \n");
    appendSummary("", "ignored");
    expect(readFileSync(file, "utf8")).toBe("### Result\n");
  });
});

describe("preflight", () => {
  const base = {
    apiUrl: "https://api.github.test",
    branch: "patchworks/update",
    repository: "owner/repo",
    token: "secret",
  };

  it("blocks immediately when no token is available", async () => {
    const fetchImpl = vi.fn();
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
      token: "",
    });

    expect(result).toMatchObject({
      blocked: true,
      outputs: {
        permission_check: "missing-token",
        status: "blocked",
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed repository identifiers", async () => {
    await expect(
      preflight({
        ...base,
        customToken: false,
        fetchImpl: vi.fn(),
        repository: "owner/repo/extra",
      }),
    ).rejects.toThrow("Invalid GitHub repository identifier");
  });

  it("stops before checkout when an update pull request is already open", async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, [{ html_url: "https://github.test/owner/repo/pull/7" }]),
    );
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });

    expect(result.outputs).toMatchObject({
      pull_request_url: "https://github.test/owner/repo/pull/7",
      skip: "true",
      status: "pull-request-open",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("handles an open pull request without a usable URL", async () => {
    const fetchImpl = vi.fn(async () => response(200, [{}]));
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result.message).toBe("An open Patchworks pull request already exists.");
    expect(result.outputs).toMatchObject({
      permission_check: "custom-token",
      pull_request_url: "",
      skip: "true",
    });
  });

  it("rejects a non-array pull request response", async () => {
    await expect(
      preflight({
        ...base,
        customToken: false,
        fetchImpl: vi.fn(async () => response(200, { items: [] })),
      }),
    ).rejects.toThrow("invalid pull request response");
  });

  it("uses a custom token without attempting the unavailable settings API", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(404, { message: "Not Found" }));
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result.blocked).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.outputs.permission_check).toBe("custom-token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("warns honestly when GITHUB_TOKEN settings and unattended CI cannot be verified", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(404, { message: "Not Found" }));
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });

    expect(result.blocked).toBe(false);
    expect(result.outputs.permission_check).toBe("not-verifiable");
    expect(result.message).toContain("does not grant this token the Administration permission");
    expect(result.message).toContain(
      "Settings > Actions > General > Workflow permissions",
    );
    expect(result.message).toContain("do not trigger normal unattended CI");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves a GitHub Enterprise API path and sends authenticated requests", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(404, { message: "Not Found" }));
    const result = await preflight({
      ...base,
      apiUrl: "https://github.enterprise.test/api/v3",
      branch: "patchworks/update",
      customToken: true,
      fetchImpl,
    });

    expect(result).toMatchObject({
      blocked: false,
      outputs: { permission_check: "custom-token", status: "ready" },
    });
    const [pullsUrl, request] = fetchImpl.mock.calls[0];
    expect(String(pullsUrl)).toBe(
      "https://github.enterprise.test/api/v3/repos/owner/repo/pulls?state=open&head=owner%3Apatchworks%2Fupdate&per_page=1",
    );
    expect(request.headers).toMatchObject({
      Authorization: "Bearer secret",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      "https://github.enterprise.test/api/v3/repos/owner/repo/git/ref/heads/patchworks/update",
    );
  });

  it("reuses only an update branch matching the newest merged pull request head", async () => {
    const currentSha = "c".repeat(40);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(
        response(200, { object: { sha: currentSha } }),
      )
      .mockResolvedValueOnce(
        response(200, [
          {
            head: { sha: "a".repeat(40) },
            merged_at: "2025-01-01T00:00:00Z",
          },
          {
            head: { sha: "d".repeat(40) },
            merged_at: null,
          },
          {
            head: { sha: currentSha },
            merged_at: "2026-01-01T00:00:00Z",
          },
        ]),
      );
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result).toMatchObject({
      blocked: false,
      outputs: { permission_check: "custom-token", status: "ready" },
    });
    const closedPullsUrl = fetchImpl.mock.calls[2][0];
    expect(closedPullsUrl.searchParams.get("state")).toBe("closed");
    expect(closedPullsUrl.searchParams.get("head")).toBe(
      "owner:patchworks/update",
    );
    expect(closedPullsUrl.searchParams.get("per_page")).toBe("100");
  });

  it("blocks an orphan branch whose head differs from the newest merged pull request", async () => {
    const branchHead = "b".repeat(40);
    const mergedHead = "a".repeat(40);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(
        response(200, { object: { sha: branchHead } }),
      )
      .mockResolvedValueOnce(
        response(200, [
          { head: { sha: mergedHead }, merged_at: "2026-01-01T00:00:00Z" },
        ]),
      );
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.outputs.status).toBe("blocked");
    expect(result.message).toContain("cannot prove it is an untouched branch");
    expect(result.message).toContain(mergedHead);
    expect(result.message).toContain(branchHead);
  });

  it("blocks an existing branch with no merged pull request history", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(
        response(200, { object: { sha: "b".repeat(40) } }),
      )
      .mockResolvedValueOnce(
        response(200, [
          { head: { sha: "b".repeat(40) }, merged_at: null },
        ]),
      );
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.outputs.permission_check).toBe("not-verifiable");
    expect(result.message).toContain("No merged pull request");
    expect(result.message).toContain("will not overwrite");
  });

  it("fails closed on invalid existing-branch metadata", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { object: {} }));
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("invalid metadata");
  });

  it("fails closed when merged pull request history is invalid", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(
        response(200, { object: { sha: "b".repeat(40) } }),
      )
      .mockResolvedValueOnce(response(200, { items: [] }));
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("invalid pull-request history");
  });

  it("fails closed when it cannot determine whether an update PR exists", async () => {
    const fetchImpl = vi.fn(async () => response(403, { message: "Forbidden" }));
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("would not overwrite human conflict resolutions");
  });

  it("includes non-Error lookup failures without exposing a stack", async () => {
    const fetchImpl = vi.fn(async () => Promise.reject("offline"));
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("offline");
  });

  it("fails closed when it cannot inspect an existing update branch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(500, { message: "Unavailable" }));
    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("could not determine whether update branch");
    expect(result.message).toContain("orphaned or human commits");
  });

  it("fails closed when it cannot inspect merged pull request history", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(
        response(200, { object: { sha: "b".repeat(40) } }),
      )
      .mockResolvedValueOnce(response(403, { message: "Forbidden" }));
    const result = await preflight({
      ...base,
      customToken: true,
      fetchImpl,
    });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("could not verify its merged pull-request history");
  });

  it("rejects malformed successful API JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "not json",
    }));

    const result = await preflight({
      ...base,
      customToken: false,
      fetchImpl,
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("Unexpected token");
  });
});

describe("workflow permission guard", () => {
  it("blocks workflow changes made with GITHUB_TOKEN", () => {
    const result = guardWorkflowChanges({
      customToken: false,
      workflowFiles: [".github/workflows/release.yml"],
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("Workflows write access");
    expect(result.message).toContain(".github/workflows/release.yml");
  });

  it("allows workflow changes when the caller supplied a custom token", () => {
    expect(
      guardWorkflowChanges({
        customToken: true,
        workflowFiles: [".github/workflows/release.yml"],
      }).blocked,
    ).toBe(false);
  });

  it("allows an empty workflow list and safely displays unusual paths", () => {
    expect(
      guardWorkflowChanges({ customToken: false, workflowFiles: [] }),
    ).toEqual({ blocked: false });

    const result = guardWorkflowChanges({
      customToken: false,
      workflowFiles: [".github/workflows/`release`.yml"],
    });
    expect(result.message).toContain(
      ".github/workflows/\\`release\\`.yml",
    );
  });
});

describe("CLI package resolution and execution", () => {
  it("uses the exact package version checked into the action ref", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const manifestDirectory = join(directory, "packages", "patchworks");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(
      join(manifestDirectory, "package.json"),
      JSON.stringify({ name: "patchworks", version: "1.2.3" }),
    );
    expect(resolvePackageSpec(directory, "")).toBe("patchworks@1.2.3");
  });

  it("accepts an explicit safe package spec without reading a manifest", () => {
    expect(resolvePackageSpec("/does-not-exist", "patchworks@2.0.0-rc.1")).toBe(
      "patchworks@2.0.0-rc.1",
    );
  });

  it("rejects package specs that could be interpreted as npm options", () => {
    expect(() => resolvePackageSpec("/unused", "--package=evil")).toThrow(
      "single safe npm package spec",
    );
    expect(() => resolvePackageSpec("/unused", "patchworks@1\n--evil")).toThrow(
      "single safe npm package spec",
    );
    expect(() =>
      resolvePackageSpec("/unused", `patchworks@1${String.fromCodePoint(127)}`),
    ).toThrow("single safe npm package spec");
    expect(() => resolvePackageSpec("/unused", "a".repeat(2_049))).toThrow(
      "single safe npm package spec",
    );
  });

  it.each([
    [{ name: "not-patchworks", version: "1.2.3" }, "Invalid Patchworks package manifest"],
    [{ name: "patchworks", version: 123 }, "Invalid Patchworks package manifest"],
    [{ name: "patchworks", version: "v1" }, "Invalid Patchworks package version"],
  ])("rejects an invalid checked-in package manifest", (manifest, message) => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const manifestDirectory = join(directory, "packages", "patchworks");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(join(manifestDirectory, "package.json"), JSON.stringify(manifest));

    expect(() => resolvePackageSpec(directory, "")).toThrow(message);
  });

  it("surfaces a malformed checked-in package manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const manifestDirectory = join(directory, "packages", "patchworks");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(join(manifestDirectory, "package.json"), "not json");

    expect(() => resolvePackageSpec(directory, "")).toThrow(
      /JSON|Unexpected token/,
    );
  });

  it("passes package specs and tokens as process arguments and environment only", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    writeConfig(directory, "https://github.com/owner/template.git");
    const githubOutput = join(directory, "output.txt");
    const spawn = vi.fn(() => ({ status: 0 }));
    runUpdate({
      actionPath: "/unused",
      githubOutput,
      packageSpec: "https://pkg.pr.new/o/r@abc?token=$NOT_SHELL",
      spawn,
      token: "token-value",
      workspace: directory,
    });

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toContain(
      "--package=https://pkg.pr.new/o/r@abc?token=$NOT_SHELL",
    );
    expect(args).toContain("--registry=https://registry.npmjs.org/");
    expect(options.env.GIT_CONFIG_VALUE_0).toContain("basic ");
    expect(options.env.npm_config_registry).toBe(
      "https://registry.npmjs.org/",
    );
    expect(options.cwd).not.toBe(directory);
    expect(options.cwd).toMatch(/patchworks-action-/);
    expect(options.env.GITHUB_WORKSPACE).toBe(directory);
    expect(JSON.stringify(args)).not.toContain("token-value");
  });

  it("preserves existing Git config entries when adding authentication", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    writeConfig(directory, "https://github.com/owner/template.git");
    const spawn = vi.fn(() => ({ status: 0 }));
    const previous = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = "2";

    try {
      runUpdate({
        actionPath: "/unused",
        githubOutput: join(directory, "output.txt"),
        packageSpec: "patchworks@1.2.3",
        spawn,
        token: "secret",
        workspace: directory,
      });
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previous;
    }

    const options = spawn.mock.calls[0][2];
    expect(options.env.GIT_CONFIG_COUNT).toBe("3");
    expect(options.env.GIT_CONFIG_KEY_2).toBe(
      "http.https://github.com/.extraheader",
    );
  });

  it("falls back to the first Git config slot for an invalid inherited count", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    writeConfig(directory, "https://github.com/owner/template.git");
    const spawn = vi.fn(() => ({ status: 0 }));
    const previous = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = "invalid";

    try {
      runUpdate({
        actionPath: "/unused",
        githubOutput: join(directory, "output.txt"),
        packageSpec: "patchworks@1.2.3",
        spawn,
        token: "secret",
        workspace: directory,
      });
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previous;
    }

    const options = spawn.mock.calls[0][2];
    expect(options.env.GIT_CONFIG_COUNT).toBe("1");
    expect(options.env.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/.extraheader",
    );
  });

  it("scopes HTTPS authentication to github.server_url", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    writeConfig(
      directory,
      "https://github.enterprise.test/owner/template.git",
    );
    const spawn = vi.fn(() => ({ status: 0 }));
    runUpdate({
      actionPath: "/unused",
      githubOutput: join(directory, "output.txt"),
      packageSpec: "patchworks@1.2.3",
      serverUrl: "https://github.enterprise.test",
      spawn,
      token: "enterprise-token",
      workspace: directory,
    });

    const options = spawn.mock.calls[0][2];
    expect(options.env.GIT_CONFIG_COUNT).toBe("1");
    expect(options.env.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.enterprise.test/.extraheader",
    );
    expect(options.env.GIT_CONFIG_VALUE_0).toContain("basic ");
  });

  it.each([
    [
      "git@github.enterprise.test:owner/template.git",
      "git@github.enterprise.test:",
    ],
    [
      "ssh://git@github.enterprise.test/owner/template.git",
      "ssh://git@github.enterprise.test/",
    ],
  ])("rewrites same-host SSH template transport %s to authenticated HTTPS", (repository, rewriteFrom) => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    writeConfig(directory, repository);
    const spawn = vi.fn(() => ({ status: 0 }));
    runUpdate({
      actionPath: "/unused",
      githubOutput: join(directory, "output.txt"),
      packageSpec: "patchworks@1.2.3",
      serverUrl: "https://github.enterprise.test",
      spawn,
      token: "enterprise-token",
      workspace: directory,
    });

    const options = spawn.mock.calls[0][2];
    expect(options.env.GIT_CONFIG_COUNT).toBe("2");
    expect(options.env.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.enterprise.test/.extraheader",
    );
    expect(options.env.GIT_CONFIG_KEY_1).toBe(
      "url.https://github.enterprise.test/.insteadOf",
    );
    expect(options.env.GIT_CONFIG_VALUE_1).toBe(rewriteFrom);
  });

  it.each([
    "https://github.enterprise.test.evil.example/owner/template.git",
    "git@evil.example:owner/template.git",
    "ssh://git@evil.example/owner/template.git",
  ])("never exposes the token to a template on another host: %s", (repository) => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    writeConfig(directory, repository);
    const spawn = vi.fn(() => ({ status: 0 }));
    const previousGithubToken = process.env.GITHUB_TOKEN;
    const previousPatchworksToken = process.env.PATCHWORKS_TOKEN;
    process.env.GITHUB_TOKEN = "must-not-leak";
    process.env.PATCHWORKS_TOKEN = "must-not-leak";
    try {
      runUpdate({
        actionPath: "/unused",
        githubOutput: join(directory, "output.txt"),
        packageSpec: "patchworks@1.2.3",
        serverUrl: "https://github.enterprise.test",
        spawn,
        token: "must-not-leak",
        workspace: directory,
      });
    } finally {
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
      if (previousPatchworksToken === undefined) delete process.env.PATCHWORKS_TOKEN;
      else process.env.PATCHWORKS_TOKEN = previousPatchworksToken;
    }

    const options = spawn.mock.calls[0][2];
    expect(JSON.stringify(options.env)).not.toContain("must-not-leak");
  });

  it("runs without Git authentication and returns report metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const githubOutput = join(directory, "output.txt");
    const spawn = vi.fn(() => ({ status: 0 }));
    const result = runUpdate({
      actionPath: "/unused",
      githubOutput,
      packageSpec: "patchworks@1.2.3",
      spawn,
      token: "",
      workspace: directory,
    });

    expect(result.resolvedPackage).toBe("patchworks@1.2.3");
    expect(result.reportPath).toMatch(/patchworks-action-.*report\.json$/);
    expect(readFileSync(githubOutput, "utf8")).toContain(
      `report_path<<`,
    );
    expect(spawn.mock.calls[0][2].env.npm_config_registry).toBe(
      "https://registry.npmjs.org/",
    );
  });

  it("surfaces package-runner process errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const failure = new Error("npm unavailable");

    expect(() =>
      runUpdate({
        actionPath: "/unused",
        githubOutput: join(directory, "output.txt"),
        packageSpec: "patchworks@1.2.3",
        spawn: () => ({ error: failure, status: null }),
        token: "",
        workspace: directory,
      }),
    ).toThrow(failure);
  });

  it.each([
    [2, "2"],
    [null, "unknown"],
  ])("reports unsuccessful package-runner status %s", (status, label) => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));

    expect(() =>
      runUpdate({
        actionPath: "/unused",
        githubOutput: join(directory, "output.txt"),
        packageSpec: "patchworks@1.2.3",
        spawn: () => ({ status }),
        token: "",
        workspace: directory,
      }),
    ).toThrow(`Patchworks CLI exited with status ${label}`);
  });
});

describe("action metadata", () => {
  it("classifies the effective token and passes the GitHub server host", () => {
    const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
    const tokenClassification =
      "${{ (inputs.token || env.GITHUB_TOKEN || github.token) != github.token }}";

    expect(action.split(tokenClassification)).toHaveLength(3);
    expect(action).toContain(
      "PATCHWORKS_SERVER_URL: ${{ github.server_url }}",
    );
    expect(action).not.toContain("inputs.token != '' ||");
  });
});

describe("git status parsing", () => {
  it("parses rename and copy records, de-duplicates paths, and sorts output", () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout:
        "R  new.txt\0old.txt\0C  copied.txt\0source.txt\0?? z.txt\0?? old.txt\0",
    }));

    expect(readChangedPaths("/workspace", spawn)).toEqual([
      "copied.txt",
      "new.txt",
      "old.txt",
      "source.txt",
      "z.txt",
    ]);
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: "/workspace", encoding: "utf8" },
    );
  });

  it.each(["??x\0", "A file.txt\0"])(
    "rejects malformed porcelain output %j",
    (stdout) => {
      expect(() =>
        readChangedPaths("/workspace", () => ({ status: 0, stdout })),
      ).toThrow("Unable to parse git status output safely");
    },
  );

  it("rejects a rename record without its source path", () => {
    expect(() =>
      readChangedPaths("/workspace", () => ({
        status: 0,
        stdout: "R  new.txt\0",
      })),
    ).toThrow("rename or copy without a source path");
  });

  it("surfaces git process errors and unsuccessful statuses", () => {
    const failure = new Error("git missing");
    expect(() =>
      readChangedPaths("/workspace", () => ({ error: failure, status: null })),
    ).toThrow(failure);
    expect(() =>
      readChangedPaths("/workspace", () => ({ status: 128 })),
    ).toThrow("git status failed with status 128");
    expect(() =>
      readChangedPaths("/workspace", () => ({ status: null })),
    ).toThrow("git status failed with status unknown");
  });

  it("treats missing successful stdout as a clean worktree", () => {
    expect(
      readChangedPaths("/workspace", () => ({ status: 0 })),
    ).toEqual([]);
  });
});

describe("report collection", () => {
  it("derives rejects and workflow changes from the real worktree", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        commitMessage: "Patchworks update",
        currentCommit: "a".repeat(40),
        hadConflicts: true,
        hasChanges: true,
        nextCommit: "b".repeat(40),
        prBody: "## Rejects\n\n- None\n\n## Metadata\n\nDetails",
        prTitle: "Update template",
        rejectFiles: [".patchworks-rejects/bbbbbbb.patch"],
        status: "conflicts",
      }),
    );
    const spawn = vi.fn(() => ({
      status: 0,
      stdout:
        " M .github/workflows/ci.yml\0?? .patchworks-rejects/bbbbbbb.patch\0?? conflict.txt.rej\0?? odd\\nname.txt\0",
    }));

    const result = collectReport({ reportPath, spawn, workspace: directory });

    expect(result.outputs).toMatchObject({
      has_rejects: "true",
      had_conflicts: "true",
      reject_files_json:
        '[".patchworks-rejects/bbbbbbb.patch","conflict.txt.rej"]',
      status: "conflicts",
      workflow_changes: "true",
      workflow_files_json: '[".github/workflows/ci.yml"]',
    });
    expect(result.outputs.engine_status).toBe("conflicts");
    expect(result.outputs.pr_body).toContain(
      "- `.patchworks-rejects/bbbbbbb.patch`",
    );
    expect(result.outputs.pr_body).toContain("- `conflict.txt.rej`");
    expect(result.outputs.pr_body).not.toContain("- None");
    expect(result.outputs.pr_body).toContain("## Metadata");
    expect(result.summary).toContain("Reject artifacts: 2");
    expect(result.summary).toContain(".patchworks-rejects/<commit>/");
  });

  it("honors engine conflict state when an artifact is absent from git status", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        commitMessage: "Patchworks update",
        hadConflicts: true,
        hasChanges: true,
        prBody: "## Rejects\n\n- None",
        prTitle: "Update template",
        rejectFiles: [".patchworks-rejects/commit.patch"],
        status: "conflicts",
      }),
    );

    const result = collectReport({
      reportPath,
      spawn: () => ({ status: 0, stdout: " M .patchworks.json\0" }),
      workspace: directory,
    });

    expect(result.outputs).toMatchObject({
      engine_status: "conflicts",
      had_conflicts: "true",
      has_changes: "true",
      has_rejects: "true",
      reject_files_json: '[".patchworks-rejects/commit.patch"]',
      status: "conflicts",
    });
    expect(result.outputs.pr_body).toContain(
      "- `.patchworks-rejects/commit.patch`",
    );
  });

  it("does not downgrade an engine conflict when no artifact path is available", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        commitMessage: "Patchworks update",
        hadConflicts: true,
        hasChanges: true,
        prBody: "## Rejects\n\n- None",
        prTitle: "Update template",
        rejectFiles: [],
        status: "conflicts",
      }),
    );

    const result = collectReport({
      reportPath,
      spawn: () => ({ status: 0, stdout: " M .patchworks.json\0" }),
      workspace: directory,
    });

    expect(result.outputs).toMatchObject({
      engine_status: "conflicts",
      had_conflicts: "true",
      has_rejects: "false",
      status: "conflicts",
    });
    expect(result.outputs.pr_body).toContain(
      "Conflicts reported; no reject artifact paths were available.",
    );
    expect(result.outputs.pr_body).not.toContain("- None");
    expect(result.summary).toContain("Patchworks reported conflicts");
  });

  it("uses a stable up-to-date status when the worktree is clean", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        hadConflicts: false,
        hasChanges: false,
        status: "up-to-date",
      }),
    );
    const result = collectReport({
      reportPath,
      spawn: () => ({ status: 0, stdout: "" }),
      workspace: directory,
    });
    expect(result.outputs.has_changes).toBe("false");
    expect(result.outputs.had_conflicts).toBe("false");
    expect(result.outputs.status).toBe("up-to-date");
  });

  it("rejects missing, malformed, and non-object reports", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    expect(() =>
      collectReport({
        reportPath: join(directory, "missing.json"),
        spawn: vi.fn(),
        workspace: directory,
      }),
    ).toThrow("did not produce a valid report");

    for (const [name, contents, message] of [
      ["malformed.json", "not json", "did not produce a valid report"],
      ["null.json", "null", "must be a JSON object"],
      ["array.json", "[]", "must be a JSON object"],
      ["string.json", '"report"', "must be a JSON object"],
    ]) {
      const reportPath = join(directory, name);
      writeFileSync(reportPath, contents);
      expect(() =>
        collectReport({
          reportPath,
          spawn: () => ({ status: 0, stdout: "" }),
          workspace: directory,
        }),
      ).toThrow(message);
    }
  });

  it("requires commit and pull request metadata when changes exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(reportPath, JSON.stringify({ hasChanges: true }));
    expect(() =>
      collectReport({
        reportPath,
        spawn: () => ({ status: 0, stdout: "" }),
        workspace: directory,
      }),
    ).toThrow("missing commitMessage");

    writeFileSync(
      reportPath,
      JSON.stringify({ commitMessage: "Update", hasChanges: true, prTitle: " " }),
    );
    expect(() =>
      collectReport({
        reportPath,
        spawn: () => ({ status: 0, stdout: "" }),
        workspace: directory,
      }),
    ).toThrow("missing prTitle");
  });

  it("accepts snake-case reports and ignores invalid reported reject entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        commit_message: "Update parent",
        current_commit: 123,
        had_conflicts: false,
        has_changes: true,
        next_commit: null,
        pr_body: "Parent update details",
        pr_title: "Update parent",
        reject_files: [42, "notes.txt", ".patchworks-rejects/kept.patch"],
        status: "updates-ready",
      }),
    );

    const result = collectReport({
      reportPath,
      spawn: () => ({ status: 0, stdout: "" }),
      workspace: directory,
    });
    expect(result.outputs).toMatchObject({
      commit_message: "Update parent",
      current_commit: "123",
      has_rejects: "true",
      next_commit: "",
      pr_title: "Update parent",
      reject_files_json: '[".patchworks-rejects/kept.patch"]',
      status: "conflicts",
    });
    expect(result.outputs.pr_body).toContain("Parent update details");
    expect(result.outputs.pr_body).toContain("## Rejects");
  });

  it("derives updates-ready status and recognizes only workflow YAML files", () => {
    const directory = mkdtempSync(join(tmpdir(), "patchworks-action-test-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        commitMessage: "Update parent",
        prBody: 42,
        prTitle: "Update parent",
        rejectFiles: {},
      }),
    );

    const result = collectReport({
      reportPath,
      spawn: () => ({
        status: 0,
        stdout:
          " M regular.txt\0 M .github/workflows/CI.YAML\0 M .github/workflows/readme.md\0 M other/workflow.yml\0",
      }),
      workspace: directory,
    });
    expect(result.outputs).toMatchObject({
      engine_status: "",
      has_changes: "true",
      has_rejects: "false",
      pr_body: "## Rejects\n\n- None",
      status: "updates-ready",
      workflow_changes: "true",
      workflow_files_json: '[".github/workflows/CI.YAML"]',
    });
  });
});

describe("workflow file parsing", () => {
  it("parses only string entries and defaults empty input", () => {
    expect(parseWorkflowFiles("")).toEqual([]);
    expect(
      parseWorkflowFiles(
        JSON.stringify([".github/workflows/ci.yml", 42, null, {}]),
      ),
    ).toEqual([".github/workflows/ci.yml"]);
    expect(parseWorkflowFiles(JSON.stringify({ file: "ci.yml" }))).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseWorkflowFiles("not json")).toThrow(
      /JSON|Unexpected token/,
    );
  });
});
