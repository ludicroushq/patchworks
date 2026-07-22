# Agent Onboarding Notes

## Repository layout

- Patchworks is a Bun workspace orchestrated with Turborepo. The root package is
  private and contains repository-wide tooling.
- `packages/patchworks` is the public Node.js CLI package. Its entrypoint is
  `packages/patchworks/src/index.ts` and its Brocli commands live in
  `packages/patchworks/src/commands`.
- Core create and update behavior lives in `packages/patchworks/src/create`,
  `packages/patchworks/src/update`, and `packages/patchworks/src/core`.
- `action.yml` defines the composite GitHub Action. Its checked-in runtime and
  tests live in `action/`.
- `docs` is an independent Next.js and Fumadocs workspace whose content lives in
  `docs/content/docs`.
- `skills/patchworks-update` is the installable agent skill for reviewing and
  applying template updates locally.

## Tooling

- Use Bun 1.3.8 or newer for repository development. `.mise.toml` pins the
  expected Bun and Node versions.
- `bun run build` builds all workspaces with Turbo; the CLI uses tsdown.
- `bun run lint` runs Oxlint, and `bun run typecheck` checks the workspaces and
  tests.
- `bun run test` runs package tests. `bun run test:coverage` runs the complete
  Vitest suite, including the GitHub Action runtime tests.
- `bun run check` runs lint, typecheck, builds, coverage, and packed-artifact
  verification. Run it before handing off a change.
- Releases use Changesets. `bun run release` builds, verifies, and publishes the
  public package; release automation creates the immutable `v<semver>` action
  tag and advances the matching `v<major>` tag.

## Behavioral invariants

- `create` must preserve the template's exact Git tree. Do not replace its
  commit-tree flow with a filesystem copy or `git add .`.
- `.patchworks.json` and `.github/workflows/patchworks.yaml` are reserved control
  paths. Writes must remain symlink-safe and collision-safe.
- `update` applies one first-parent template commit per run with strict patches.
  It must begin from a clean tree and leave normal file changes unstaged for
  plain `git diff` review. Gitlink pointer changes are the sole staging
  exception and must be reviewed with `git diff --cached`.
- Conflict artifacts belong under `.patchworks-rejects/<commit>/`. Never report
  a conflicted update as clean or hide artifacts from the pull-request body.
- Rewritten history requires explicit `--rebase`; unavailable or pruned tracked
  commits must fail with actionable guidance.
- The GitHub Action checks for an existing Patchworks pull request before
  checkout. Preserve that ordering so scheduled runs cannot overwrite human
  fixes.
- The action runs the exact CLI package version associated with its action
  revision. Do not reintroduce a floating package install.
- Workflow-file updates require a caller-supplied token with Workflows write
  access. `GITHUB_TOKEN` is not sufficient for that case.

## Working in the repository

- Keep CLI behavior in the package and GitHub-specific orchestration in
  `action/`.
- Add regression coverage for Git graphs, unusual filenames, binary/mode
  changes, symlinks, dirty trees, conflict artifacts, and Actions permissions
  when changing those surfaces.
- Preserve user changes already present in the worktree. Do not commit or push
  unless the user explicitly asks for those Git side effects.
