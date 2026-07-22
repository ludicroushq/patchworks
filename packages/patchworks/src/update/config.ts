import { constants } from "node:fs";
import { lstat, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";

const MAX_CONFIG_BYTES = 1024 * 1024;

export type PatchworksConfig = {
  commit: string;
  template: {
    repository: string;
    branch?: string;
  };
  version?: string;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRepository(repository: string): void {
  if (
    repository.length === 0 ||
    repository.startsWith("-") ||
    repository.includes("\0") ||
    repository.includes("\r") ||
    repository.includes("\n")
  ) {
    throw new Error("template.repository is not a valid Git repository");
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(repository)) {
    let parsed: URL;
    try {
      parsed = new URL(repository);
    } catch {
      throw new Error("template.repository is not a valid URL");
    }

    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (parsed.password || (isHttp && parsed.username)) {
      throw new Error(
        "template.repository must not contain credentials; use a Git credential helper instead",
      );
    }

    if (parsed.search || parsed.hash) {
      throw new Error(
        "template.repository must not contain a query string or fragment",
      );
    }
  }
}

export function parsePatchworksConfig(raw: string): PatchworksConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to parse .patchworks.json. Ensure it is valid JSON. ${detail}`,
    );
  }

  if (!isRecord(value)) {
    throw new Error(".patchworks.json must contain a JSON object");
  }

  if (
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(value.commit)
  ) {
    throw new Error(
      "commit must be a full 40- or 64-character Git object ID in .patchworks.json",
    );
  }

  if (!isRecord(value.template)) {
    throw new Error("Missing template in patchworks config");
  }

  const repository = value.template.repository;
  if (typeof repository !== "string" || repository.length === 0) {
    throw new Error("Missing template.repository in patchworks config");
  }
  validateRepository(repository);

  const branch = value.template.branch;
  if (branch !== undefined && (typeof branch !== "string" || !branch)) {
    throw new Error("template.branch must be a non-empty string when provided");
  }

  const version = value.version;
  if (version !== undefined && typeof version !== "string") {
    throw new Error("version must be a string when provided");
  }

  return value as PatchworksConfig;
}

export async function readPatchworksConfig(
  workspace: string,
): Promise<{ config: PatchworksConfig; path: string; mode: number }> {
  const configPath = path.join(workspace, ".patchworks.json");
  let fileStat;
  try {
    fileStat = await lstat(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `.patchworks.json not found at ${configPath}. Cannot continue.`,
      );
    }
    throw error;
  }

  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(
      `.patchworks.json must be a regular file inside the repository (symbolic links are not allowed)`,
    );
  }
  if (fileStat.size > MAX_CONFIG_BYTES) {
    throw new Error(
      `.patchworks.json exceeds the ${MAX_CONFIG_BYTES}-byte safety limit`,
    );
  }

  const handle = await open(
    configPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const raw = await handle.readFile({ encoding: "utf8" });
    return {
      config: parsePatchworksConfig(raw),
      path: configPath,
      mode: fileStat.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

export async function writePatchworksConfig(
  configPath: string,
  config: PatchworksConfig,
  mode: number,
): Promise<void> {
  const directory = path.dirname(configPath);
  const temporaryPath = path.join(
    directory,
    `.patchworks.json.tmp-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(temporaryPath, "wx", mode);

  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();

  const current = await lstat(configPath);
  if (current.isSymbolicLink() || !current.isFile()) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("Refusing to replace an unsafe .patchworks.json path");
  }

  await rename(temporaryPath, configPath);
  await stat(configPath);
}
