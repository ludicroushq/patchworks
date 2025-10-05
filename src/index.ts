#!/usr/bin/env node
import { run } from "@drizzle-team/brocli";
import { version } from "../package.json";
import { createCommand } from "./commands/create";

run([createCommand], {
  name: "patchworks",
  description: "Sync GitHub repositories with their template sources",
  version,
});
