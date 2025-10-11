import { afterEach, describe, expect, it } from "vitest";
import {
  buildPullRequestBody,
  parseGithubSlug,
  toCommitUrl,
  toCompareUrl,
} from "../index";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("parseGithubSlug", () => {
  it("handles https urls", () => {
    expect(parseGithubSlug("https://github.com/org/repo")).toEqual("org/repo");
  });

  it("handles ssh urls", () => {
    expect(parseGithubSlug("git@github.com:org/repo.git")).toEqual("org/repo");
  });

  it("returns null for unsupported hosts", () => {
    expect(parseGithubSlug("https://example.com/org/repo")).toBeNull();
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
    expect(body).toContain("Body: Details about change.");
    expect(body).toContain("## Template Metadata");
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
    expect(body).not.toContain("Body:");
  });
});
