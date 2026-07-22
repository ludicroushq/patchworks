import { positional, command, string } from "@drizzle-team/brocli";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";

import { version } from "../../package.json";
import {
  createRepository,
  inferRepositoryName,
} from "../create/index.js";

export {
  buildPatchworksWorkflow,
  createPatchworksCommitEnv,
  createRepository,
  inferRepositoryName,
  validateRepository,
} from "../create/index.js";

async function promptForDestination(defaultName: string): Promise<string | null> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let interrupted = false;
  readline.once("SIGINT", () => {
    interrupted = true;
    readline.close();
  });

  try {
    const answer = await readline.question(
      `Enter destination folder (${defaultName}): `,
    );
    return answer.trim().length === 0 ? defaultName : answer;
  } catch (error) {
    if (interrupted) {
      return null;
    }
    throw error;
  } finally {
    readline.close();
  }
}

export const createCommand = command({
  name: "create",
  desc: "Clone a template repository and initialize it for Patchworks",
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
  handler: async (options) => {
    try {
      const defaultName = inferRepositoryName(options.repoUrl);
      const destination =
        options.destination ?? (await promptForDestination(defaultName));
      if (destination === null) {
        console.log(chalk.yellow("\nOperation cancelled by user"));
        return;
      }

      const result = await createRepository({
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        destination,
        onProgress: (message) => console.log(chalk.blue(message)),
        repoUrl: options.repoUrl,
      });

      console.log(
        chalk.green(`
Repository initialized with Patchworks!
- Template repo: ${options.repoUrl}
- Branch: ${result.branch}
- Last synced commit: ${result.templateCommit}
- Destination: ${result.destination}
- Patchworks version: ${version}
      `),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Error creating repository: ${message}`));
      process.exitCode = 1;
    }
  },
});
