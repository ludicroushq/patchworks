import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import { configExists, createConfig } from "../utils/config.js";
import { isGitRepo, cloneRepo, getCurrentCommit } from "../utils/git.js";

/**
 * Initialize patchworks in the current repository
 */
export const init = async (
  source: string,
  options: { branch: string },
): Promise<void> => {
  // Check if we're in a git repository
  if (!(await isGitRepo())) {
    console.error(
      chalk.red(
        "Error: Not a git repository. Please run this command in a git repository.",
      ),
    );
    process.exit(1);
  }

  // Check if patchworks is already initialized
  if (await configExists()) {
    console.error(
      chalk.red("Error: Patchworks is already initialized in this repository."),
    );
    process.exit(1);
  }

  // Normalize the source URL
  let sourceRepo = source;
  if (sourceRepo.endsWith(".git")) {
    sourceRepo = sourceRepo.slice(0, -4);
  }
  if (sourceRepo.startsWith("git@github.com:")) {
    sourceRepo = sourceRepo.replace("git@github.com:", "https://github.com/");
  }

  // Clone the source repository to get its latest commit
  try {
    console.log(chalk.blue(`Fetching ${sourceRepo} (${options.branch})...`));
    const tempRepoPath = await cloneRepo(sourceRepo, options.branch);
    const latestCommit = await getCurrentCommit(tempRepoPath);

    // Create the patchworks config
    await createConfig(sourceRepo, options.branch, latestCommit);

    // Create GitHub workflow directory
    const workflowsDir = path.join(process.cwd(), ".github", "workflows");
    await fs.mkdir(workflowsDir, { recursive: true });

    // Create GitHub workflow file
    const workflowContent = `name: Patchworks Sync

on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'  # Run daily at midnight

jobs:
  patchworks:
    runs-on: ubuntu-latest
    steps:
      - uses: ludicroushq/patchworks-action@v0
`;

    await fs.writeFile(
      path.join(workflowsDir, "patchworks-sync.yml"),
      workflowContent,
    );

    // Success message
    console.log(chalk.green("Patchworks initialized successfully!"));
    console.log(
      chalk.green(
        `Tracking ${sourceRepo} (${options.branch}) at commit ${latestCommit.slice(0, 7)}`,
      ),
    );
    console.log(
      chalk.green(
        "GitHub workflow created at .github/workflows/patchworks-sync.yml",
      ),
    );
    console.log();
    console.log("Next steps:");
    console.log(
      "  1. Commit the new files: git add .patchworks.json .github/workflows/patchworks-sync.yml",
    );
    console.log(
      '  2. Push to GitHub: git commit -m "Initialize Patchworks" && git push',
    );
  } catch (error) {
    console.error(
      chalk.red(
        `Error initializing Patchworks: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
};
