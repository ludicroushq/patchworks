import { spawn } from "node:child_process";
import process from "node:process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type RunOptions = {
  allowFailure?: boolean;
  input?: string;
  maxOutputBytes?: number;
};

export type GitRunner = (
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function displayArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(argument)) {
    return argument;
  }

  return JSON.stringify(argument);
}

export function formatGitCommand(args: readonly string[]): string {
  return ["git", ...args.map(displayArgument)].join(" ");
}

export function createGitRunner(workspace: string): GitRunner {
  return async (args, options = {}) =>
    new Promise<CommandResult>((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd: workspace,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const maxOutputBytes =
        options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      let outputBytes = 0;
      let outputLimitError: Error | undefined;

      const collect = (chunks: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes && !outputLimitError) {
          outputLimitError = new Error(
            `${formatGitCommand(args)} produced more than ${maxOutputBytes} bytes of output`,
          );
          child.kill("SIGTERM");
          return;
        }
        chunks.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (outputLimitError) {
          reject(outputLimitError);
          return;
        }

        const result: CommandResult = {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          code: code ?? 1,
        };

        if (result.code !== 0 && !options.allowFailure) {
          const detail = result.stderr.trim() || result.stdout.trim();
          const signalDetail = signal ? ` (signal ${signal})` : "";
          reject(
            new Error(
              `${formatGitCommand(args)} failed with exit code ${result.code}${signalDetail}${detail ? `\n${detail}` : ""}`,
            ),
          );
          return;
        }

        resolve(result);
      });

      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
}
