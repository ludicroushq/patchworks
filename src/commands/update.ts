import { command, string } from "@drizzle-team/brocli";
import chalk from "chalk";
import { runPatchworksUpdate } from "../update/index.js";

const parseBooleanFlag = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }
  if (value === "") {
    return true;
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
    json: string().desc("Emit JSON run metadata to stdout (suppresses logs)"),
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

      const wantsJson = parseBooleanFlag(opts.json, false);

      const result = await runPatchworksUpdate({ silent: wantsJson });

      if (wantsJson) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }

      if (!result.hasChanges) {
        console.log(chalk.yellow("No template updates to apply."));
        return;
      }

      const current = result.currentCommit.slice(0, 7);
      const next = result.nextCommit.slice(0, 7);
      console.log(
        chalk.green(
          `Prepared Patchworks update ${current} -> ${next} on branch ${result.branchName}`,
        ),
      );
      console.log(
        chalk.blue(
          "Changes are ready in your working tree. Review, commit, and open a PR when ready.",
        ),
      );
    } catch (error) {
      console.error(chalk.red("Patchworks update failed:"));
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
});
