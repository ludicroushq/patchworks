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
    branch: string().desc("Branch to clone").default("main"),
  },
  handler: async (opts) => {
    try {
      const { repoUrl, branch } = opts;

      // Extract repo name from the URL
      const defaultRepoName = repoUrl.split("/").pop()?.replace(".git", "");

      if (!defaultRepoName) {
        console.error(chalk.red("Invalid repository URL"));
        process.exit(1);
      }

      // Ask for folder destination using inquirer
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "folderName",
          message: "Enter destination folder:",
          default: defaultRepoName,
        },
      ]);

      const folderName = answers.folderName;

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

      console.log(chalk.blue(`Cloning ${repoUrl} into ${folderName}...`));

      // Use shallow clone (--depth 1) to only get the latest commit
      // This is significantly faster and uses less resources
      await $`git clone --depth 1 ${repoUrl} ${folderName} --branch ${branch}`;

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

      // Configure git with Patchworks author info for this repo only
      await git.addConfig("user.name", "Patchworks", false, "local");
      await git.addConfig(
        "user.email",
        "patchworks@ludicroushq.com",
        false,
        "local",
      );

      // Add all files and create initial commit with explicit author settings
      await git.add(".");
      await git.commit("Initial commit", {
        "--author": "Patchworks <patchworks@ludicroushq.com>",
      });

      // Create .patchworks.json file
      const patchworksConfig = {
        version,
        template: {
          repository: repoUrl,
          branch,
        },
        commit: latestCommit,
      };

      await fs.writeFile(
        ".patchworks.json",
        JSON.stringify(patchworksConfig, null, 2),
        "utf-8",
      );

      // Create GitHub Action workflow
      const workflowDir = path.join(process.cwd(), ".github", "workflows");
      await fs.mkdir(workflowDir, { recursive: true });

      const workflowContent = `name: Patchworks Sync

on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'

jobs:
  patchworks:
    runs-on: ubuntu-latest
    steps:
      - uses: ludicroushq/patchworks@${version}
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
      await git.commit("Configure Patchworks", {
        "--author": "Patchworks <patchworks@ludicroushq.com>",
      });

      console.log(
        chalk.green(`
Repository initialized with Patchworks!
- Template repo: ${repoUrl}
- Branch: ${branch}
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
