function escapeMarkdown(value: string): string {
  return value
    .replaceAll("@", "@\u200b")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]]/g, "\\$&");
}

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, length - 1)}…`;
}

function escapeCode(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replaceAll("`", "\\`")
    .replaceAll("@", "@\u200b");
}

export function parseGithubSlug(repositoryUrl: string): string | null {
  const cleaned = repositoryUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let slug: string | undefined;

  if (cleaned.startsWith("git@github.com:")) {
    slug = cleaned.slice("git@github.com:".length);
  } else if (cleaned.startsWith("ssh://git@github.com/")) {
    slug = cleaned.slice("ssh://git@github.com/".length);
  } else {
    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
        slug = parsed.pathname.replace(/^\/+/, "");
      }
    } catch {
      return null;
    }
  }

  if (!slug || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    return null;
  }
  return slug;
}

export function toCommitUrl(
  repositoryUrl: string,
  commit: string,
): string | null {
  const slug = parseGithubSlug(repositoryUrl);
  return slug ? `https://github.com/${slug}/commit/${commit}` : null;
}

export function toCompareUrl(
  repositoryUrl: string,
  fromCommit: string,
  toCommit: string,
): string | null {
  const slug = parseGithubSlug(repositoryUrl);
  return slug
    ? `https://github.com/${slug}/compare/${fromCommit}...${toCommit}`
    : null;
}

export type BuildPullRequestBodyInput = {
  templateRepo: string;
  templateBranch: string;
  currentCommit: string;
  nextCommit: string;
  commitSubject: string;
  commitBody?: string | null;
  compareUrl?: string | null;
  commitUrl?: string | null;
  rejectFiles: string[];
  rebased?: boolean;
};

export function buildPullRequestBody(input: BuildPullRequestBodyInput): string {
  const subject = escapeMarkdown(
    truncate(input.commitSubject.trim() || "(no subject)", 300),
  );
  const commitBody = truncate(input.commitBody?.trim() ?? "", 4_000);
  const safeBody = commitBody
    .split(/\r?\n/)
    .map((line) => `> ${escapeMarkdown(line)}`)
    .join("\n");
  const rejects =
    input.rejectFiles.length === 0
      ? "- None"
      : input.rejectFiles
          .map((file) => `- \`${escapeCode(file)}\``)
          .join("\n");
  const diffLink = input.compareUrl
    ? `- Diff: ${input.compareUrl}`
    : input.commitUrl
      ? `- Commit: ${input.commitUrl}`
      : null;
  const mode = input.rebased
    ? "- Mode: explicit rewritten-history rebase"
    : null;

  return [
    "## Changes",
    `### Subject: **${subject}**`,
    safeBody || null,
    "## Rejects",
    rejects,
    input.rejectFiles.length > 0
      ? "Resolve every reject artifact and remove it before merging."
      : null,
    "## Template Metadata",
    [
      `- Template: \`${escapeMarkdown(input.templateRepo)}\` (branch \`${escapeMarkdown(input.templateBranch)}\`)`,
      diffLink,
      `- Previous commit: ${input.currentCommit}`,
      `- New commit: ${input.nextCommit}`,
      mode,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
