export interface PatchworksConfig {
  /**
   * The source repository URL
   */
  sourceRepo: string;

  /**
   * The branch name to track from the source repository
   */
  sourceBranch: string;

  /**
   * The last synced commit from the source repository
   */
  lastSyncedCommit: string;

  /**
   * Version of patchworks used
   */
  version: string;
}

export const CONFIG_FILENAME = ".patchworks.json";
