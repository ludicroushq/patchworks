#!/usr/bin/env node
import { command, string, boolean, run } from "@drizzle-team/brocli";
import { init } from "./commands/init.js";
import { sync } from "./commands/sync.js";
import { version } from "../package.json";

const initCommand = command({
  name: "init",
  desc: "Initialize patchworks in the current repository",
  options: {
    source: string().required(),
    branch: string().default("main"),
  },
  handler: (options) => init(options.source, { branch: options.branch }),
});

const syncCommand = command({
  name: "sync",
  desc: "Sync changes from the source repository",
  options: {
    apply: boolean().default(false),
  },
  handler: (options) => sync({ apply: options.apply }),
});

run([initCommand, syncCommand], {
  name: "patchworks",
  description: "Sync GitHub repositories with their template sources",
  version,
});
