import { boolean, command, string } from "@drizzle-team/brocli";
import chalk from "chalk";
import { promises as fs } from "node:fs";
import { runPatchworksUpdate } from "../update/index.js";

export const updateCommand = command({
  name: "update",
  desc: "Apply the next template commit to the current repository",
  options: {
    report: string().desc("Write JSON report to the specified file path"),
    rebase: boolean().desc(
      "Explicitly apply an aggregate diff when template history was rewritten",
    ),
  },
  handler: async (opts) => {
    try {
      const result = await runPatchworksUpdate({ rebase: opts.rebase ?? false });

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
        result.hadConflicts
          ? chalk.yellow(
              `Prepared Patchworks update ${current} -> ${next} with conflicts`,
            )
          : chalk.green(`Prepared Patchworks update ${current} -> ${next}`),
      );
      if (result.hadConflicts) {
        console.log(
          chalk.yellow(
            `Resolve and remove every reject artifact before committing:\n${result.rejectFiles.join("\n")}`,
          ),
        );
      } else {
        console.log(
          chalk.blue(
            "Changes are in your working tree. Validate and commit them when ready.",
          ),
        );
      }
      if (result.stagedFiles.length > 0) {
        console.log(
          chalk.yellow(
            `Gitlink changes remain staged and require git diff --cached review:\n${result.stagedFiles.join("\n")}`,
          ),
        );
      }
    } catch (error) {
      console.error(chalk.red("Patchworks update failed:"));
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },
});
