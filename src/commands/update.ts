import { command, string } from "@drizzle-team/brocli";
import chalk from "chalk";
import { runPatchworksUpdate } from "../action/index.js";

const parseBooleanFlag = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value === "") {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

export const updateCommand = command({
  name: "update",
  desc: "Sync the current repository with its Patchworks template",
  options: {
    token: string().desc(
      "GitHub token with repo scope; defaults to GITHUB_TOKEN env",
    ),
    repository: string().desc(
      "owner/repo identifier; defaults to GITHUB_REPOSITORY env",
    ),
    baseBranch: string().desc(
      "Branch to use as the base (overrides PATCHWORKS_BASE_BRANCH)",
    ),
    branchName: string().desc(
      "Branch to push updates to (overrides PATCHWORKS_BRANCH_NAME)",
    ),
    gitName: string().desc("Git author name (overrides PATCHWORKS_GIT_NAME)"),
    gitEmail: string().desc(
      "Git author email (overrides PATCHWORKS_GIT_EMAIL)",
    ),
    commit: string().desc("Whether to commit the changes (default: false)"),
    push: string().desc(
      "Whether to push the update branch (default: matches commit)",
    ),
    pr: string().desc(
      "Whether to open a pull request (default: matches commit & push)",
    ),
    outputFile: string().desc("Write run metadata to the provided file path"),
  },
  handler: async (opts) => {
    try {
      if (opts.token) {
        process.env.GITHUB_TOKEN = opts.token;
      }

      if (opts.repository) {
        process.env.GITHUB_REPOSITORY = opts.repository;
      }

      if (opts.baseBranch) {
        process.env.PATCHWORKS_BASE_BRANCH = opts.baseBranch;
      }

      if (opts.branchName) {
        process.env.PATCHWORKS_BRANCH_NAME = opts.branchName;
      }

      if (opts.gitName) {
        process.env.PATCHWORKS_GIT_NAME = opts.gitName;
      }

      if (opts.gitEmail) {
        process.env.PATCHWORKS_GIT_EMAIL = opts.gitEmail;
      }

      const commitFlag = parseBooleanFlag(opts.commit, false);
      const pushFlag = parseBooleanFlag(opts.push, commitFlag);
      const prFlag = parseBooleanFlag(opts.pr, commitFlag && pushFlag);
      const outputFile = opts.outputFile || undefined;

      const result = await runPatchworksUpdate({
        commit: commitFlag,
        push: pushFlag,
        createPr: prFlag,
        outputFile,
      });

      if (!result.hasChanges) {
        console.log(chalk.yellow("No template updates to apply."));
      } else {
        const current = result.currentCommit.slice(0, 7);
        const next = result.nextCommit.slice(0, 7);
        console.log(
          chalk.green(
            `Prepared Patchworks update ${current} -> ${next} on branch ${result.branchName}`,
          ),
        );

        if (!commitFlag) {
          console.log(
            chalk.blue(
              "Changes are ready in your working tree. Review and commit when ready.",
            ),
          );
        }
      }

      if (outputFile) {
        console.log(chalk.gray(`Wrote run metadata to ${outputFile}`));
      }
    } catch (error) {
      console.error(chalk.red("Patchworks update failed:"));
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
});
