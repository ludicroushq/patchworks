import { command, string } from "@drizzle-team/brocli";
import chalk from "chalk";
import { runPatchworksUpdate } from "../update/index.js";

const parseBooleanFlag = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  if (value === "") {
    return true;
  }
  const normalized = value.toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
};

export const updateCommand = command({
  name: "update",
  desc: "Apply the next template commit to the current repository",
  options: {
    json: string().desc("Emit run metadata as JSON (suppresses normal logs)"),
  },
  handler: async (opts) => {
    try {
      const wantsJson = parseBooleanFlag(opts.json);

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
          "Changes are in your working tree. Commit and open a PR when ready.",
        ),
      );
    } catch (error) {
      console.error(chalk.red("Patchworks update failed:"));
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
});
