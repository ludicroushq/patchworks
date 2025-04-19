import fs from "fs/promises";
import path from "path";
import { type PatchworksConfig, CONFIG_FILENAME } from "../types.js";
import { version } from "../../package.json";

/**
 * Get the path to the config file
 */
export const getConfigPath = async (): Promise<string> => {
  const cwd = process.cwd();
  return path.join(cwd, CONFIG_FILENAME);
};

/**
 * Check if the config file exists
 */
export const configExists = async (): Promise<boolean> => {
  try {
    const configPath = await getConfigPath();
    await fs.access(configPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read the config file
 */
export const readConfig = async (): Promise<PatchworksConfig> => {
  const configPath = await getConfigPath();
  const configData = await fs.readFile(configPath, "utf-8");
  return JSON.parse(configData);
};

/**
 * Write the config file
 */
export const writeConfig = async (config: PatchworksConfig): Promise<void> => {
  const configPath = await getConfigPath();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
};

/**
 * Create a new config file
 */
export const createConfig = async (
  sourceRepo: string,
  sourceBranch: string,
  lastSyncedCommit: string,
): Promise<PatchworksConfig> => {
  const config: PatchworksConfig = {
    sourceRepo,
    sourceBranch,
    lastSyncedCommit,
    version,
  };

  await writeConfig(config);
  return config;
};

/**
 * Update the lastSyncedCommit in the config
 */
export const updateLastSyncedCommit = async (
  commitHash: string,
): Promise<void> => {
  const config = await readConfig();
  config.lastSyncedCommit = commitHash;
  await writeConfig(config);
};
