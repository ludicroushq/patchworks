# Patchworks

Patchworks keeps a project connected to the template it came from. It records
the exact template commit and prepares later template changes one first-parent
commit at a time, without treating the project as a conventional Git fork.

Project-specific changes stay in place. Each template update becomes a normal,
reviewable working-tree diff or pull request.

## Install

```bash
npm install --global patchworks
# or
bun add --global patchworks
```

Patchworks requires Node.js 18 or newer.

To give a coding agent the official end-to-end update workflow, install the
included skill with the Skills CLI:

```bash
npx skills add ludicroushq/patchworks --skill patchworks-update
```

## Create a project

```bash
patchworks create https://github.com/example/template my-project
cd my-project
```

`create` makes an exact-tree root commit from the selected template branch, then
adds `.patchworks.json` and `.github/workflows/patchworks.yaml` in a second
commit. This preserves tracked files, executable modes, binary content, and
Git links while removing the template's reachable history and remote.

Patchworks will not overwrite its reserved files. It also refuses to write
through symbolic links or unsafe `.github` paths. The destination is prepared
in a temporary sibling directory and moved into place only after setup succeeds.

Local setup attributes both commits to the `user.name` and `user.email` active
where `patchworks create` was invoked. Configure both values first; Patchworks
fails instead of inventing a bot identity when either is missing. In GitHub
Actions, it uses the triggering actor and the verified
`<GITHUB_ACTOR_ID>+<GITHUB_ACTOR>@users.noreply.github.com` address, falling
back to the username-only noreply form only when GitHub omits the actor ID.

Use `--branch <name>` to follow a branch other than the template's default.

## Prepare an update

```bash
patchworks update
git status --short
git diff
git diff --cached
```

An update requires a clean working tree. Patchworks fetches the configured
template branch, finds the next commit on its first-parent history, applies a
strict binary-capable patch, and advances `.patchworks.json`. It prepares one
commit per run. Normal file changes are unstaged so they appear in a plain
`git diff`.

Gitlink changes are the one staging exception: a submodule pointer has no
worktree content that can represent a new commit, so Patchworks leaves that
index entry staged. Review `git diff --cached` whenever an update contains a
submodule.

If Git cannot apply every hunk cleanly, Patchworks keeps the partial result for
review and writes the full patch plus per-file rejects beneath
`.patchworks-rejects/<commit>/`. Resolve the code, remove every reject artifact,
validate the project, and only then commit. A later run prepares the next
template commit.

For automation, `--report <path>` writes structured JSON. If the template's
history was rewritten but the recorded commit is still available, review the
new history and pass `--rebase` to explicitly apply the aggregate old-to-new
diff. Patchworks cannot reconstruct a diff after the recorded object has been
pruned and can no longer be fetched.

## GitHub Action

`patchworks create` installs a scheduled workflow. A minimal workflow is:

```yaml
name: Patchworks

on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * *"

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: patchworks-${{ github.repository }}
  cancel-in-progress: false

jobs:
  patchworks:
    runs-on: ubuntu-latest
    steps:
      # Use a GitHub App token or fine-grained PAT for private cross-repository
      # templates, workflow-file updates, or unattended CI on the resulting PR.
      - uses: ludicroushq/patchworks@v0
        with:
          token: ${{ secrets.PATCHWORKS_TOKEN }}
```

The custom token is optional. With no secret, the action falls back to
`GITHUB_TOKEN`. Before checkout it looks for an open `patchworks/update` pull
request and skips the run if one exists, so a scheduled run cannot replace
human conflict resolutions. It also refuses to reuse an update branch unless
its head exactly matches the newest merged Patchworks pull request, protecting
orphaned or human commits. Because `GITHUB_TOKEN` cannot read the repository's
Actions administration setting, Patchworks warns you to enable pull-request
creation instead of claiming it verified that setting. Prepared changes are
committed and opened with
[`peter-evans/create-pull-request`](https://github.com/peter-evans/create-pull-request).

Newly generated workflows pin the exact Patchworks action version that created
them. Upgrade that `v<semver>` tag deliberately (or pin a full commit SHA); it
does not follow a moving major tag. The action executes the exact `patchworks`
package version recorded by its own revision, not `patchworks@latest`. The
`patchworks-package` input exists for testing an exact canary package.

Four GitHub permission details matter:

- Enable **Settings → Actions → General → Workflow permissions → Allow GitHub
  Actions to create and approve pull requests** when using `GITHUB_TOKEN`.
- `GITHUB_TOKEN` cannot push changes to `.github/workflows`. If the template may
  update workflow files, pass a GitHub App token or fine-grained personal access
  token through `with: token` with Contents, Pull requests, and Workflows write
  access.
- The same custom token needs read access to a private template in another
  repository on the same GitHub host. The action safely authenticates same-host
  HTTPS, SCP-style, and `ssh://git@...` URLs; other hosts keep using their own
  ambient Git credentials.
- Use a custom token as well when bot pull requests must trigger unattended CI.
  Pull-request workflow runs created with `GITHUB_TOKEN` are approval-gated.

See the full guides at [patchworks.dev](https://patchworks.dev).

## Development

This repository is a Bun and Turborepo monorepo:

```bash
bun install
bun run check
```

The published CLI lives in `packages/patchworks`, the documentation site lives
in `docs`, and the root GitHub Action is implemented by `action.yml` and
`action/`.

## License

MIT
