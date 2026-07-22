# Patchworks

Patchworks keeps a project synchronized with its template source one commit at
a time while preserving project-specific changes for review.

## Install

```bash
npm install --global patchworks
# or
bun add --global patchworks
```

Node.js 18 or newer is required.

Install the official agent workflow for safely applying every pending update:

```bash
npx skills add ludicroushq/patchworks --skill patchworks-update
```

## Create

```bash
patchworks create https://github.com/example/template my-project
patchworks create https://github.com/example/template my-project --branch next
```

The new repository starts with the template's exact tracked tree, followed by a
commit containing `.patchworks.json` and the scheduled Patchworks workflow.
Patchworks refuses to overwrite those reserved paths or write through symbolic
links.

When run locally, `create` preserves the effective Git `user.name` and
`user.email` from the invocation directory and fails with configuration
instructions if either is missing. In GitHub Actions it attributes commits to
`GITHUB_ACTOR`, using
`<GITHUB_ACTOR_ID>+<GITHUB_ACTOR>@users.noreply.github.com` when the actor ID is
available.

The generated workflow pins the exact `v<semver>` action version that created
it, so upgrades are intentional. A GitHub App token or fine-grained PAT is
needed when updates can change workflows, the template is private and in
another repository, or Patchworks pull requests must trigger unattended CI
without approval.

## Update

```bash
cd my-project
patchworks update
git diff
git diff --cached
```

The working tree must be clean. Each run applies the next first-parent template
commit and leaves normal file changes unstaged for review. Gitlink changes stay
staged because a submodule pointer has no worktree representation, so inspect
`git diff --cached` when an update contains a submodule. Conflicts are collected
in `.patchworks-rejects/<commit>/`; resolve the result and remove every artifact
before committing.

Use `patchworks update --report ./patchworks-report.json` for structured output.
If reviewed template history was rewritten while the recorded object is still
available, `patchworks update --rebase` explicitly applies the aggregate diff.

The GitHub Action and complete configuration reference are documented at
[patchworks.dev](https://patchworks.dev).
