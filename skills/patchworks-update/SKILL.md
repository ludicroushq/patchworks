---
name: patchworks-update
description: Safely update a repository from its Patchworks parent template one update at a time, resolving centralized or legacy reject artifacts and project-specific adaptations, validating each update, and committing before continuing. Use when asked to sync, update, or merge a Patchworks-managed repository, run `patchworks update`, resolve `.patchworks-rejects` or `.rej` files, recover from rewritten template history, or troubleshoot Patchworks update automation and pull requests.
---

# Patchworks Update

Advance the child repository through every pending parent commit without erasing intentional divergence. Treat each generated patch as a reviewable proposal that must be adapted, validated, and committed before applying the next one. Ordinary file changes are unstaged; Gitlink pointer changes are the intentional exception and remain staged because Git has no working-tree representation for them. A deliberately reviewed `--rebase` applies one aggregate old-to-new template diff as a single cycle.

## Preflight

1. Read the repository guidance, including `AGENTS.md`, package-manager metadata, `.patchworks.json`, CI configuration, and relevant contributor docs.
2. Inspect `git status --short --untracked-files=all`, staged and unstaged diffs, the current branch, and recent history.
3. Require a clean worktree at the start of a new cycle. Never stash, reset, discard, or commit unrelated work. If existing changes are an unfinished Patchworks cycle, finish that cycle before running the command again; otherwise stop and identify the paths the owner must isolate.
4. Record the template repository, branch, and current commit from `.patchworks.json`.

## Choose the runner

Honor an explicit repository command first. Otherwise prefer the package manager declared by `packageManager` or evidenced by the lockfile, and verify the executable exists with `command -v`. Resolve the Patchworks package spec before invoking a one-shot runner: use the version or package URL pinned in dependencies or automation. Treat `.patchworks.json.version` only as creator provenance; it is not a runtime package pin.

- Use a local installation when present: `pnpm exec patchworks update`, `bunx patchworks update`, `npm exec -- patchworks update`, or `yarn exec patchworks update`.
- If Patchworks is not installed locally, pass the resolved spec to the available one-shot runner: `pnpm dlx <package-spec> update`, `bunx <package-spec> update`, `npx --yes <package-spec> update`, or `yarn dlx <package-spec> update`.
- Use `patchworks@latest` only when the repository has no pinned version or package URL and its guidance permits tracking latest. Do not change package managers or mutate a lockfile merely to invoke the CLI.

## Apply one update

1. Run exactly one Patchworks update command.
2. Capture the full output, exit status, and structured report when one is requested. An exit code of zero means the engine prepared a reviewable result; it does not mean the patch is conflict-free. Treat report `status: "conflicts"`, `hadConflicts: true`, listed reject files, or equivalent console output as requiring resolution.
3. Expect ordinary engine changes to remain unstaged and reviewable with plain `git diff`, including new files marked intent-to-add. Gitlink pointer changes remain staged and appear in the report's `stagedFiles`; review them with `git diff --cached`. Do not stage any additional paths until review and resolution are complete.
4. Patchworks normally advances `.patchworks.json` by one first-parent commit, even when part of the parent diff needs manual resolution. Do not invoke Patchworks again until the current result is completely reviewed, resolved, validated, and committed.

## Review and adapt

1. Inspect every changed, deleted, renamed, and untracked path with `git status --short --untracked-files=all`, `git diff --stat`, plain `git diff`, `git diff --cached`, and targeted file reads. The post-update staged diff should contain only Gitlink pointer changes listed in `stagedFiles`; otherwise it must be empty. Check file modes, binary files, generated artifacts, lockfiles, and `.patchworks.json`.
2. Inspect every centralized conflict artifact under `.patchworks-rejects/<commit>/`: read `template.patch` for the complete attempted parent diff and every `files/<path>.rej` for rejected hunks. Also find and review legacy `*.rej` files anywhere outside `.git`.
3. Read each rejected hunk beside its target file and reconstruct the parent's intent. Apply the compatible intent manually, or deliberately decline it when the child has replaced or removed that behavior. Account for every hunk before removing any reject artifact.
4. Replace parent-template placeholders with child-specific values. Infer names, domains, package identifiers, environment keys, routes, and copy from authoritative local files, preserving the local casing and conventions.
5. Preserve intentional divergence. Keep shared fixes to tooling, security, dependencies, build configuration, and framework conventions when compatible, but do not resurrect subsystems, pages, dependencies, or policies the child intentionally removed or replaced.
6. Regenerate lockfiles and generated outputs with the repository's existing tools when their sources changed; do not hand-edit generated hunks.
7. After resolving or deliberately declining every hunk, remove the entire current `.patchworks-rejects/<commit>/` artifact tree, including `template.patch`, and remove every applicable legacy `.rej` file. Never commit conflict artifacts. Remove the empty `.patchworks-rejects` directory when no other cycles remain.
8. Confirm `.patchworks.json` moved from the recorded commit to the single expected next parent commit, or to the explicitly reviewed new tip for a rebase cycle. Keep that advance even when a parent hunk was intentionally declined: it records that the update was considered.

## Validate and commit

1. Run the repository's documented formatting, linting, type-checking, tests, and build checks in proportion to the change. Start targeted, then run the normal full validation when practical. Do not start persistent services or mutate external systems without authorization.
2. Reinspect both the final unstaged diff and the staged Gitlink-only diff. Run `git diff --check`, confirm no conflict markers, `.patchworks-rejects` artifacts, or legacy `.rej` files remain, and ensure unrelated changes are absent.
3. Stage only the completed Patchworks update and inspect the staged diff. Commit it with the CLI-provided message when available; otherwise use `Patchworks: sync <old> -> <new>` for a normal cycle or `Patchworks: rebase <old> -> <new>` for a reviewed rebase.
4. Create exactly one child commit per Patchworks cycle. A normal cycle maps to one parent commit; an explicit rebase cycle maps to its one aggregate old-to-new diff. Never squash multiple cycles together.
5. With a clean worktree, run one update again. Repeat the entire cycle until Patchworks reports that the repository already matches the latest template commit.

## Failure handling

- **Dirty worktree:** Patchworks intentionally refuses to run. Do not bypass the check. Separate unrelated work outside this workflow, or finish and commit the already-applied Patchworks cycle before retrying.
- **Rewritten parent history:** First verify the repository URL and branch in `.patchworks.json`, fetch full parent history, and inspect why the tracked commit left first-parent history. Confirm that the tracked object still exists and review the aggregate diff from it to the intended new tip. Use `--rebase` only after that explicit, verified review; it is not a generic retry flag. The flag may fetch an old commit that the remote still retains, but it cannot reconstruct an object already pruned by the remote and local Git database. Recover the object from a trustworthy clone or archive, or choose and document a manually audited migration baseline before retrying.
- **Rejected hunks:** A partially applied patch is current work, not a reason to rerun. Conflict status may still exit zero. Resolve or deliberately decline every centralized and legacy reject hunk, remove all reject artifacts including the full patch, validate, and commit the cycle first.
- **Action version drift:** Preserve the workflow's exact `ludicroushq/patchworks@v<semver>` tag or full commit SHA. Do not replace it with `@v<major>`, `@main`, or `@latest`; upgrade the immutable reference only as a deliberate Patchworks release change.
- **Workflow-file changes:** Review `.github/workflows/**` separately. A credential that can write repository contents may still be unable to create or update workflows. Use a GitHub App or fine-grained token with **Workflows: read and write**, or a classic token with the `workflow` scope, when the update branch changes workflow files. Do not omit the files or weaken protections to make the push pass.
- **Private cross-repository template:** The child repository's `GITHUB_TOKEN` cannot read another private repository. Use a GitHub App installation token or PAT with Contents read access to the template and the required write access to the child. The official action scopes that token to `github.server_url` and authenticates same-host HTTPS, SCP-style `git@host:path`, and `ssh://git@host/path` template URLs; URLs on other hosts keep using their own ambient credentials and never receive the token.
- **Bot cannot open a pull request or trigger unattended CI:** Give the job `contents: write` and `pull-requests: write`; use a full checkout when Patchworks needs history. When using `GITHUB_TOKEN`, enable **Allow GitHub Actions to create and approve pull requests** under repository or organization Actions settings. Patchworks cannot verify that Administration setting with `GITHUB_TOKEN`. Pull-request workflow runs created by that token are approval-gated, so use a GitHub App token or PAT when the project's usual CI must start without manual approval. Check organization policy, branch rules, fork restrictions, and whether an existing Patchworks PR already owns the update branch before changing credentials.
- **Orphaned update branch:** Patchworks refuses to reuse an update branch without an open pull request unless its head exactly matches the newest merged Patchworks pull request. Inspect the branch and pull-request history; rename or delete the branch deliberately only after proving it contains no work that must be preserved.
- **Transient runner, registry, network, or Git failure:** Preserve the exact command and error, repair only safe local prerequisites, and retry once when appropriate. Do not loop blindly or report success without a clean, validated commit.

## Handoff

Report the parent commits applied, child commits created, parent changes adapted or declined, rejects resolved, validation commands and results, and any remaining permission or policy blocker. Distinguish local completion from a successful push and pull-request creation.
