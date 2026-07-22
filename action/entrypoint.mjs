#!/usr/bin/env node

import {
  appendSummary,
  collectReport,
  guardWorkflowChanges,
  parseWorkflowFiles,
  preflight,
  runUpdate,
  writeCommandFile,
  writeError,
  writeWarning,
} from "./runtime.mjs";

const mode = process.argv[2];

async function main() {
  switch (mode) {
    case "preflight": {
      const result = await preflight({
        apiUrl: process.env.PATCHWORKS_API_URL || "https://api.github.com",
        branch: process.env.PATCHWORKS_BRANCH || "patchworks/update",
        customToken: process.env.PATCHWORKS_CUSTOM_TOKEN === "true",
        repository: process.env.PATCHWORKS_REPOSITORY || "",
        token: process.env.PATCHWORKS_TOKEN || "",
      });
      writeCommandFile(process.env.GITHUB_OUTPUT, result.outputs);
      if (result.message) {
        if (result.blocked) writeError(result.message);
        else if (result.outputs.skip === "true") console.log(result.message);
        else writeWarning(result.message);
      }
      if (result.blocked) process.exitCode = 1;
      return;
    }

    case "update": {
      const { resolvedPackage } = runUpdate({
        actionPath: process.env.PATCHWORKS_ACTION_PATH || "",
        githubOutput: process.env.GITHUB_OUTPUT,
        packageSpec: process.env.PATCHWORKS_PACKAGE || "",
        serverUrl: process.env.PATCHWORKS_SERVER_URL || "https://github.com",
        token: process.env.PATCHWORKS_TOKEN || "",
        workspace: process.env.PATCHWORKS_WORKSPACE || process.cwd(),
      });
      console.log(`Executed ${resolvedPackage}`);
      return;
    }

    case "collect": {
      const result = collectReport({
        reportPath: process.env.PATCHWORKS_REPORT || "",
        workspace: process.env.PATCHWORKS_WORKSPACE || process.cwd(),
      });
      writeCommandFile(process.env.GITHUB_OUTPUT, result.outputs);
      appendSummary(process.env.GITHUB_STEP_SUMMARY, result.summary);
      if (result.outputs.had_conflicts === "true") {
        writeWarning(
          "Patchworks produced reject artifacts. Resolve and remove every legacy .rej file and the current .patchworks-rejects/<commit>/ artifact tree before merging the pull request.",
        );
      }
      return;
    }

    case "guard-workflows": {
      const result = guardWorkflowChanges({
        customToken: process.env.PATCHWORKS_CUSTOM_TOKEN === "true",
        workflowFiles: parseWorkflowFiles(
          process.env.PATCHWORKS_WORKFLOW_FILES_JSON || "[]",
        ),
      });
      if (result.blocked) {
        writeError(result.message);
        process.exitCode = 1;
      }
      return;
    }

    default:
      throw new Error(`Unknown Patchworks action mode: ${mode || "(missing)"}`);
  }
}

try {
  await main();
} catch (error) {
  writeError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
