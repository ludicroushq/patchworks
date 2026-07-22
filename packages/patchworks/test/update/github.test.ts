import { describe, expect, it } from "vitest";
import {
  buildPullRequestBody,
  parseGithubSlug,
  toCommitUrl,
  toCompareUrl,
} from "../../src/update/index";

describe("parseGithubSlug", () => {
  it("handles https urls", () => {
    expect(parseGithubSlug("https://github.com/org/repo")).toEqual("org/repo");
  });

  it("handles ssh urls", () => {
    expect(parseGithubSlug("git@github.com:org/repo.git")).toEqual("org/repo");
    expect(parseGithubSlug("ssh://git@github.com/org/repo.git")).toEqual(
      "org/repo",
    );
  });

  it("returns null for unsupported hosts", () => {
    expect(parseGithubSlug("https://example.com/org/repo")).toBeNull();
    expect(parseGithubSlug("https://github.com/org/repo/extra")).toBeNull();
    expect(parseGithubSlug("file:///org/repo")).toBeNull();
  });
});

describe("github urls", () => {
  it("generates commit url with slug", () => {
    expect(toCommitUrl("https://github.com/org/repo", "abc123")).toEqual(
      "https://github.com/org/repo/commit/abc123",
    );
  });

  it("generates compare url", () => {
    expect(toCompareUrl("https://github.com/org/repo", "abc", "def")).toEqual(
      "https://github.com/org/repo/compare/abc...def",
    );
  });

  it("returns null when slug missing", () => {
    expect(toCommitUrl("https://example.com/org/repo", "abc123")).toBeNull();
  });
});

describe("buildPullRequestBody", () => {
  it("includes compare url and rejects", () => {
    const body = buildPullRequestBody({
      templateRepo: "https://github.com/org/repo",
      templateBranch: "main",
      currentCommit: "abc",
      nextCommit: "def",
      commitSubject: "Update",
      commitBody: "Details about change.",
      compareUrl: "https://example.com/compare",
      commitUrl: null,
      rejectFiles: ["src/file.rej"],
    });

    expect(body).toContain("Diff: https://example.com/compare");
    expect(body).toContain("`src/file.rej`");
    expect(body).toContain("### Subject: **Update**");
    expect(body).toContain("> Details about change.");
    expect(body).toContain("## Template Metadata");
    expect(body).toContain("Resolve every reject artifact");
  });

  it("falls back to commit url and handles no rejects", () => {
    const body = buildPullRequestBody({
      templateRepo: "https://github.com/org/repo",
      templateBranch: "main",
      currentCommit: "abc",
      nextCommit: "def",
      commitSubject: "",
      commitBody: "",
      compareUrl: null,
      commitUrl: "https://example.com/commit",
      rejectFiles: [],
    });

    expect(body).toContain("Commit: https://example.com/commit");
    expect(body).toContain("- None");
    expect(body).toContain("(no subject)");
    expect(body).not.toContain("Resolve every reject artifact");
  });

  it("neutralizes mentions and markdown supplied by template commits", () => {
    const body = buildPullRequestBody({
      templateRepo: "local<repo>",
      templateBranch: "main`branch",
      currentCommit: "abc",
      nextCommit: "def",
      commitSubject: "Ping @everyone **now** <script>",
      commitBody: "@maintainers\n<script>alert(1)</script>",
      rejectFiles: [],
      rebased: true,
    });

    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("<script>");
    expect(body).toContain("explicit rewritten-history rebase");
  });

  it("keeps hostile reject filenames inside a single inert code span", () => {
    const body = buildPullRequestBody({
      templateRepo: "https://github.com/org/repo",
      templateBranch: "main",
      currentCommit: "abc",
      nextCommit: "def",
      commitSubject: "Update",
      rejectFiles: ["src/`break\n@everyone.rej"],
    });

    expect(body).toContain("`src/\\`break\\n@\u200beveryone.rej`");
    expect(body).not.toContain("\n@everyone");
  });
});
