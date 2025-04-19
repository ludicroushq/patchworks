# Patchworks

Automatically sync your repository with updates from its template source.

## Problem

When you clone a template repository, you lose the connection to the original template. If the template author fixes a bug or makes an improvement, there's no easy way to pull those changes into your repository.

## Solution

Patchworks creates an automated system that:

1. Tracks which template repository your project was based on
2. Periodically checks for updates to the template
3. Creates a pull request with those changes when they're available

## Installation

```bash
npm install -g patchworks
```

## Usage

### Initialize in your repository

```bash
# Navigate to your repository that was based on a template
cd my-project

# Initialize patchworks with the original template repository
patchworks init https://github.com/original/template

# By default, it tracks the 'main' branch, but you can specify another:
patchworks init https://github.com/original/template --branch develop
```

This will:

- Create a `.patchworks.json` config file
- Set up a GitHub workflow to check for updates daily

### Manually check for updates

```bash
# Check for updates without applying them
patchworks sync

# Apply updates locally
patchworks sync --apply
```

### Automated updates via GitHub Actions

Once installed, Patchworks will automatically:

1. Check daily for updates to the template repository
2. Create a pull request when updates are available
3. Update the tracking information when the PR is merged

## How It Works

Patchworks uses Git's diffing capabilities to:

1. Keep track of the last synced commit from the template
2. Fetch the latest changes from the template
3. Generate a diff between the last synced commit and the current state
4. Apply that diff to your repository

## Configuration

The `.patchworks.json` file in your repository tracks:

```json
{
  "sourceRepo": "https://github.com/original/template",
  "sourceBranch": "main",
  "lastSyncedCommit": "abc123...",
  "version": "0.1.0"
}
```

## GitHub Action

Patchworks includes a GitHub Action that automatically checks for updates:

```yaml
# .github/workflows/patchworks-sync.yml
on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * *" # Run daily at midnight

jobs:
  patchworks:
    runs-on: ubuntu-latest
    steps:
      - uses: ludicroushq/patchworks-action@v0
```

## License

MIT
