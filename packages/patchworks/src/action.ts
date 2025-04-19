#!/usr/bin/env node
import { $, fs } from "zx";
import simpleGit from "simple-git";
import path from "path";

// GitHub info
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

// Configure settings
const CONFIG_FILENAME = ".patchworks.json";
const git = simpleGit({ baseDir: GITHUB_WORKSPACE });

interface PatchworksConfig {
  sourceRepo: string;
  sourceBranch: string;
  lastSyncedCommit: string;
  version: string;
}

/**
 * Main function to run the action - this is now simplified
 * as we're using peter-evans/create-pull-request to handle PR creation
 */
async function run() {
  try {
    // Check if action is properly set up
    if (!GITHUB_TOKEN) {
      throw new Error(
        "GITHUB_TOKEN is required. Please add it to your workflow.",
      );
    }

    // Read config file
    const configPath = path.join(GITHUB_WORKSPACE, CONFIG_FILENAME);
    if (!(await fs.pathExists(configPath))) {
      throw new Error(`Config file ${CONFIG_FILENAME} not found.`);
    }

    const configData = await fs.readFile(configPath, "utf8");
    const config: PatchworksConfig = JSON.parse(configData);

    // Clone the source repository
    console.log(
      `Fetching from source repository: ${config.sourceRepo} (${config.sourceBranch})`,
    );
    const tempDir = path.join("/tmp", `patchworks-source-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Extract the GitHub repo path from the URL
    const sourceRepoPath = new URL(config.sourceRepo).pathname.slice(1);

    // Clone with token auth
    const cloneUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${sourceRepoPath}.git`;
    await $`git clone --branch ${config.sourceBranch} --single-branch ${cloneUrl} ${tempDir}`;

    // Get the latest commit from source
    const sourceGit = simpleGit({ baseDir: tempDir });
    const latestCommit = (await sourceGit.revparse(["HEAD"])).trim();

    // Check if we're already up to date
    if (latestCommit === config.lastSyncedCommit) {
      console.log("Already up to date with source repository.");
      process.exit(0);
    }

    // Generate diff
    console.log(
      `Generating diff between ${config.lastSyncedCommit.slice(0, 7)} and ${latestCommit.slice(0, 7)}...`,
    );
    const diff = await sourceGit.diff([config.lastSyncedCommit, "HEAD"]);

    if (!diff) {
      console.log("No changes to sync.");
      process.exit(0);
    }

    // Apply the diff
    console.log("Applying changes...");
    const patchFile = path.join("/tmp", `patchworks-diff.patch`);
    await fs.writeFile(patchFile, diff);

    try {
      await $`cd ${GITHUB_WORKSPACE} && git apply --reject --whitespace=fix ${patchFile}`;
    } catch (error) {
      console.log(
        "Some changes could not be applied cleanly. Check .rej files for conflicts.",
      );
    }

    // Check if there are any changes to commit
    const status = await git.status();
    if (
      !status.modified.length &&
      !status.not_added.length &&
      !status.deleted.length
    ) {
      console.log("No changes to commit after applying diff.");
      process.exit(0);
    }

    // Update the config with new commit hash
    config.lastSyncedCommit = latestCommit;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    console.log("Changes applied successfully. Ready for PR creation.");
  } catch (error) {
    console.error(
      `Action failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

run();
