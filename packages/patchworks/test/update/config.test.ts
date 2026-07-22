import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parsePatchworksConfig,
  readPatchworksConfig,
  writePatchworksConfig,
} from "../../src/update/config.js";

describe("Patchworks config I/O", () => {
  let workspace: string;
  const validConfig = {
    commit: "a".repeat(40),
    custom: { preserved: true },
    template: {
      branch: "main",
      repository: "https://github.com/example/template.git",
    },
    version: "0.1.3",
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "patchworks-config-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("reads, validates, and atomically rewrites a regular config", async () => {
    const configPath = path.join(workspace, ".patchworks.json");
    await writeFile(configPath, `${JSON.stringify(validConfig)}\n`);
    await chmod(configPath, 0o640);

    const loaded = await readPatchworksConfig(workspace);
    expect(loaded.config).toEqual(validConfig);
    expect(loaded.mode).toBe(0o640);

    await writePatchworksConfig(
      loaded.path,
      { ...loaded.config, commit: "b".repeat(40) },
      loaded.mode,
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      commit: "b".repeat(40),
      custom: { preserved: true },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  });

  it("rejects directories and oversized config files", async () => {
    await mkdir(path.join(workspace, ".patchworks.json"));
    await expect(readPatchworksConfig(workspace)).rejects.toThrow(
      "must be a regular file",
    );
    await rm(path.join(workspace, ".patchworks.json"), { recursive: true });
    await writeFile(
      path.join(workspace, ".patchworks.json"),
      " ".repeat(1024 * 1024 + 1),
    );
    await expect(readPatchworksConfig(workspace)).rejects.toThrow(
      "safety limit",
    );
  });

  it("refuses to replace a symlink target", async () => {
    const outside = path.join(workspace, "outside.json");
    const configPath = path.join(workspace, ".patchworks.json");
    await writeFile(outside, "outside\n");
    await symlink("outside.json", configPath);

    await expect(
      writePatchworksConfig(configPath, validConfig, 0o644),
    ).rejects.toThrow("unsafe .patchworks.json path");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("accepts SHA-256 IDs and rejects dangerous repository strings", () => {
    expect(
      parsePatchworksConfig(
        JSON.stringify({
          commit: "c".repeat(64),
          template: { repository: "git@github.com:example/template.git" },
        }),
      ).commit,
    ).toHaveLength(64);
    for (const repository of [
      "-option",
      "https://user:secret@github.com/example/template",
      "ssh://git:secret@github.com/example/template",
      "https://github.com/example/template?token=secret",
      "https://github.com/example/template#fragment",
      "https://[",
      "line\nbreak",
    ]) {
      expect(() =>
        parsePatchworksConfig(
          JSON.stringify({
            commit: "d".repeat(40),
            template: { repository },
          }),
        ),
      ).toThrow("repository");
    }
  });
});
