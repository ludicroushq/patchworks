import { command, string, positional } from "@drizzle-team/brocli";
import { $ } from "zx";
import { promises as fs } from "fs";
import * as path from "path";
import simpleGit from "simple-git";
import chalk from "chalk";
import inquirer from "inquirer";
import { version } from "../../package.json";
import * as tmp from "tmp";

// Configure tmp to automatically clean up on process exit
tmp.setGracefulCleanup();

export const createCommand = command({
  name: "create",
  desc: "Clone a template repository and initialize it for patchworks",
  options: {
    repoUrl: positional()
      .desc(
        "URL of the repository to clone (e.g. https://github.com/user/repo)",
      )
      .required(),
    destination: positional().desc("Destination folder (optional)"),
    branch: string().desc(
      "Branch to clone (if not specified, uses default branch)",
    ),
  },
  handler: async (opts) => {
    try {
      const { repoUrl, branch, destination } = opts;

      // Extract repo name from the URL
      const defaultRepoName = repoUrl.split("/").pop()?.replace(".git", "");

      if (!defaultRepoName) {
        console.error(chalk.red("Invalid repository URL"));
        process.exit(1);
      }

      // Use destination if provided, otherwise use defaultRepoName
      let folderName: string = destination || defaultRepoName;

      // If destination is not provided, ask for folder destination using inquirer
      if (!destination) {
        try {
          const answers = await inquirer.prompt([
            {
              type: "input",
              name: "folderName",
              message: "Enter destination folder:",
              default: defaultRepoName,
            },
          ]);

          folderName = answers.folderName;
        } catch (error) {
          // Handle Ctrl+C gracefully
          console.log(chalk.yellow("\nOperation cancelled by user"));
          process.exit(0);
        }
      }

      // Check if destination directory already exists
      try {
        const stats = await fs.stat(folderName);
        if (stats.isDirectory()) {
          // Directory exists, check if it's empty
          const files = await fs.readdir(folderName);
          if (files.length > 0) {
            console.error(
              chalk.red(
                `Error: Destination folder '${folderName}' already exists and is not empty.`,
              ),
            );
            console.error(
              chalk.yellow(
                `Please choose a different destination or delete the existing folder.`,
              ),
            );
            process.exit(1);
          }
        }
      } catch (error) {
        // Directory doesn't exist, which is what we want
        // Or there was another error, which we'll catch when trying to clone
      }

      // Determine which branch to use
      let branchToUse: string = branch || "";
      if (!branchToUse) {
        console.log(chalk.blue(`Detecting default branch for ${repoUrl}...`));
        // Create a temporary directory for branch detection
        const tempDir = tmp.dirSync();
        try {
          // Use ls-remote to find the default branch without cloning
          const git = simpleGit();
          const remote = await git.listRemote(["--symref", repoUrl, "HEAD"]);

          // Parse the output to get the default branch name
          // The output format is like:
          // ref: refs/heads/main	HEAD
          const match = remote.match(/ref: refs\/heads\/([^\t]+)\t+HEAD/);
          if (match && match[1]) {
            branchToUse = match[1];
            console.log(chalk.blue(`Using default branch: ${branchToUse}`));
          } else {
            console.log(
              chalk.yellow(
                `Could not detect default branch, falling back to main`,
              ),
            );
            branchToUse = "main";
          }
        } catch (error) {
          console.log(
            chalk.yellow(
              `Error detecting default branch: ${error}. Falling back to main`,
            ),
          );
          branchToUse = "main";
        } finally {
          // Clean up temp directory
          tempDir.removeCallback();
        }
      }

      console.log(
        chalk.blue(
          `Cloning ${repoUrl} into ${folderName} (branch: ${branchToUse})...`,
        ),
      );

      // Use shallow clone (--depth 1) to only get the latest commit
      // This is significantly faster and uses less resources
      await $`git clone --depth 1 ${repoUrl} ${folderName} --branch ${branchToUse}`;

      // Get the latest commit hash before removing git history
      const originalGit = simpleGit(folderName);
      const latestCommit = (await originalGit.revparse(["HEAD"])).trim();

      // Change into the cloned directory
      process.chdir(folderName);

      // Initialize git with Patchworks as the author
      const git = simpleGit();

      // Remove the original git history
      await $`rm -rf ${path.join(process.cwd(), ".git")}`;

      // Initialize a new git repository
      await git.init();

      // Add all files and create initial commit with explicit author and committer settings
      await git.add(".");

      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Patchworks",
        GIT_AUTHOR_EMAIL: "bot@patchworks.dev",
        GIT_COMMITTER_NAME: "Patchworks",
        GIT_COMMITTER_EMAIL: "bot@patchworks.dev",
      };

      await git.env(commitEnv).commit("Initial commit");

      // Create .patchworks.json file
      const patchworksConfig = {
        version,
        template: {
          repository: repoUrl,
          branch: branchToUse,
        },
        commit: latestCommit,
      };

      await fs.writeFile(
        ".patchworks.json",
        JSON.stringify(patchworksConfig, null, 2) + "\n",
        "utf-8",
      );

      // Create GitHub Action workflow
      const workflowDir = path.join(process.cwd(), ".github", "workflows");
      await fs.mkdir(workflowDir, { recursive: true });

      const majorVersion = version.split(".")[0];

      const workflowContent = `name: Patchworks

on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * *"

permissions:
  contents: write
  pull-requests: write

jobs:
  patchworks:
    runs-on: ubuntu-latest
    steps:
      - uses: ludicroushq/patchworks@v${majorVersion}
        with:
          patchworks-package: patchworks@${version}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

      await fs.writeFile(
        path.join(workflowDir, "patchworks.yaml"),
        workflowContent,
        "utf-8",
      );

      // Add patchworks files and create another commit
      await git.add([
        ".patchworks.json",
        path.join(workflowDir, "patchworks.yaml"),
      ]);

      await git.env(commitEnv).commit("Configure Patchworks");

      console.log(
        chalk.green(`
Repository initialized with Patchworks!
- Template repo: ${repoUrl}
- Branch: ${branchToUse}
- Last synced commit: ${latestCommit}
- Destination: ${folderName}
- Patchworks version: ${version}
      `),
      );
    } catch (error) {
      console.error(chalk.red("Error creating repository:"), error);
      process.exit(1);
    }
  },
});
