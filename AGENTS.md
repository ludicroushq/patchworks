# Agent Onboarding Notes

## Overview

- Patchworks is now a single pnpm package at the repo root that builds the CLI directly from `src/`.
- `apps/` contains the marketing site, managed independently (no pnpm workspaces).

## CLI (`src/`)

- Entrypoint: `src/index.ts` registers Brocli commands and exposes the `patchworks` binary.
- Primary command today: `create` (`src/commands/create.ts`). It shallow-clones a template repo, detects the default branch with `git ls-remote`, removes history, re-initializes Git with Patchworks bot author info, and seeds `.patchworks.json` plus `.github/workflows/patchworks.yaml`.
- Dependencies: `simple-git`, `zx`, `inquirer`, `tmp`, `chalk`, `@drizzle-team/brocli` handle Git, shell, prompts, temp dirs, and CLI plumbing.

## Website (`apps/website`)

- Next.js app configured by `next.config.mjs` and `source.config.ts`; uses content in `apps/website/content`.

## Helpful Commands

- `pnpm run build` bundles the CLI with `tsup`; `pnpm run dev` starts the watch build.
- `pnpm run test:*` for lint/format/typecheck automation (`test` chains the three helpers).
- Release flow: `pnpm run build` then `pnpm run release` (uses Changesets for publish).

## Repo Tips

- Node >= 18 required (`package.json` engines).
- Husky + lint-staged enforce formatting and linting on commits.
- No outstanding knowledge of other commands yet—check `tsup.config.ts` or script definitions when expanding functionality.
