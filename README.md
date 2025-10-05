# Patchworks

Automatically sync your repository with updates from its template source.

## Problem

When you clone a template repository, you lose the connection to the original template. If the template author fixes a bug or makes an improvement, there's no easy way to pull those changes into your repository.

## Solution

Patchworks creates an automated system that tracks which template repository your project was based on and helps you stay updated with changes.

## GitHub Action

- Fetches the template repository nightly and advances one commit past the tracked hash when updates exist.
- Applies a whitespace-tolerant diff, leaving `.rej` files alongside files that need manual attention.
- Updates `.patchworks.json`, commits on `patchworks/update`, and force-pushes the branch.
- Skips runs when a Patchworks update PR already exists and opens a fresh PR with a summary and reject list otherwise.
- Lists any `.rej` files in the PR body so you can review conflicts directly from the diff.

The generated workflow grants `contents: write` and `pull-requests: write`, checks out the repository with `fetch-depth: 0`, and exposes `GITHUB_TOKEN` to the action. Advanced users can override behaviour with environment variables such as `PATCHWORKS_BASE_BRANCH`, `PATCHWORKS_BRANCH_NAME`, `PATCHWORKS_GIT_NAME`, and `PATCHWORKS_GIT_EMAIL`.

## Documentation

For installation instructions, usage guides, and more detailed information, visit our documentation at [patchworks.dev](https://patchworks.dev).

## License

MIT
