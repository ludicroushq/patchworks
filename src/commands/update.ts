import { command, string } from "@drizzle-team/brocli";
import chalk from "chalk";
import { promises as fs } from "fs";
import { runPatchworksUpdate } from "../update/index.js";

export const updateCommand = command({
  name: "update",
  desc: "Apply the next template commit to the current repository",
  options: {
    report: string().desc("Write JSON report to the specified file path"),
  },
  handler: async (opts) => {
    try {
      const result = await runPatchworksUpdate();

      if (opts.report) {
        await fs.writeFile(
          opts.report,
          JSON.stringify(result, null, 2),
          "utf8",
        );
      }

      if (!result.hasChanges) {
        console.log(chalk.yellow("No template updates to apply."));
        return;
      }

      const current = result.currentCommit.slice(0, 7);
      const next = result.nextCommit.slice(0, 7);
      console.log(
        chalk.green(`Prepared Patchworks update ${current} -> ${next}`),
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
