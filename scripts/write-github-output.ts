#!/usr/bin/env tsx
import { readFileSync, appendFileSync } from "node:fs";
import { env, argv, exit } from "node:process";

const reportPath = argv[2] || "patchworks-output.json";
const githubOutput = env.GITHUB_OUTPUT;

if (!githubOutput) {
  console.error("GITHUB_OUTPUT environment variable not set");
  exit(1);
}

try {
  const data = JSON.parse(readFileSync(reportPath, "utf8"));

  const outputs = {
    has_changes: data.hasChanges ? "true" : "false",
    commit_message: data.commitMessage || "",
    pr_title: data.prTitle || "",
    pr_body: data.prBody || "",
  };

  for (const [key, value] of Object.entries(outputs)) {
    const stringValue = String(value);

    // Use heredoc format for multiline strings, simple format for single-line
    if (stringValue.includes("\n")) {
      appendFileSync(githubOutput, `${key}<<EOF\n${stringValue}\nEOF\n`);
    } else {
      // For single-line values, escape special characters
      const sanitized = stringValue
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");
      appendFileSync(githubOutput, `${key}=${sanitized}\n`);
    }
  }

  console.log("Successfully wrote metadata to GITHUB_OUTPUT");
} catch (error) {
  console.error(
    "Failed to process patchworks output:",
    error instanceof Error ? error.message : String(error),
  );
  exit(1);
}
