import chalk from "chalk";
import { fs } from "zx";
import path from "path";
import {
  configExists,
  readConfig,
  updateLastSyncedCommit,
} from "../utils/config.js";
import {
  isGitRepo,
  cloneRepo,
  getCurrentCommit,
  generateDiff,
  applyDiff,
} from "../utils/git.js";

/**
 * Sync changes from the source repository
 */
export const sync = async (options: { apply: boolean }): Promise<void> => {
  // Check if we're in a git repository
  if (!(await isGitRepo())) {
    console.error(chalk.red("Error: Not a git repository."));
    process.exit(1);
  }

  // Check if patchworks is initialized
  if (!(await configExists())) {
    console.error(
      chalk.red("Error: Patchworks is not initialized in this repository."),
    );
    console.error(chalk.red('Run "patchworks init <source>" to initialize.'));
    process.exit(1);
  }

  // Read the config
  const config = await readConfig();

  try {
    // Clone the source repository
    console.log(
      chalk.blue(
        `Fetching latest from ${config.sourceRepo} (${config.sourceBranch})...`,
      ),
    );
    const tempRepoPath = await cloneRepo(
      config.sourceRepo,
      config.sourceBranch,
    );

    // Get the latest commit
    const latestCommit = await getCurrentCommit(tempRepoPath);

    // Check if we're already up to date
    if (latestCommit === config.lastSyncedCommit) {
      console.log(chalk.green("Already up to date!"));
      return;
    }

    // Generate the diff
    console.log(
      chalk.blue(
        `Generating diff between ${config.lastSyncedCommit.slice(0, 7)} and ${latestCommit.slice(0, 7)}...`,
      ),
    );
    const diff = await generateDiff(tempRepoPath, config.lastSyncedCommit);

    if (!diff) {
      console.log(chalk.yellow("No changes detected."));
      return;
    }

    // Save the diff for inspection
    const diffPath = path.join(process.cwd(), "patchworks.diff");
    await fs.writeFile(diffPath, diff);
    console.log(chalk.blue(`Diff saved to ${diffPath}`));

    // Apply the diff if requested
    if (options.apply) {
      console.log(chalk.blue("Applying changes..."));
      await applyDiff(diff);

      // Update the config
      await updateLastSyncedCommit(latestCommit);
      console.log(
        chalk.green(
          `Updated last synced commit to ${latestCommit.slice(0, 7)}`,
        ),
      );
    } else {
      console.log(chalk.yellow("Run with --apply to apply the changes."));
    }
  } catch (error) {
    console.error(
      chalk.red(
        `Error syncing changes: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
};
