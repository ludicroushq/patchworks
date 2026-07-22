import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type TestRepository = {
  root: string;
  template: string;
  project: string;
  firstCommit: string;
};

export async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        code: code ?? 1,
      };
      if (result.code !== 0 && !allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${result.code}): ${result.stderr}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

export async function git(
  cwd: string,
  ...args: string[]
): Promise<string> {
  return (await run("git", args, cwd)).stdout;
}

export async function initializeGitRepository(
  repository: string,
): Promise<void> {
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "Patchworks Test");
  await git(repository, "config", "user.email", "test@patchworks.invalid");
  await git(repository, "config", "commit.gpgsign", "false");
  await git(repository, "config", "core.hooksPath", "/dev/null");
}

export async function commitAll(
  repository: string,
  message: string,
): Promise<string> {
  await git(repository, "add", "-A");
  await git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

export async function writePatchworksConfig(
  project: string,
  template: string,
  commit: string,
  branch = "main",
): Promise<void> {
  await writeFile(
    path.join(project, ".patchworks.json"),
    `${JSON.stringify(
      {
        version: "0.1.3",
        template: { repository: template, branch },
        commit,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function createBasicRepositories(): Promise<TestRepository> {
  const root = await mkdtemp(path.join(tmpdir(), "patchworks-test-"));
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  await initializeGitRepository(template);
  await writeFile(path.join(template, "hello.txt"), "version one\n", "utf8");
  const firstCommit = await commitAll(template, "template: version one");

  await initializeGitRepository(project);
  await writeFile(path.join(project, "hello.txt"), "version one\n", "utf8");
  await commitAll(project, "Initial commit");
  await writePatchworksConfig(project, template, firstCommit);
  await commitAll(project, "Configure Patchworks");

  return { root, template, project, firstCommit };
}
