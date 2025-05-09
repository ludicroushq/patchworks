# Patchworks

Automatically sync your repository with updates from its template source.

## Problem

When you clone a template repository, you lose the connection to the original template. If the template author fixes a bug or makes an improvement, there's no easy way to pull those changes into your repository.

## Solution

Patchworks creates an automated system that tracks which template repository your project was based on and helps you stay updated with changes.

## Installation

```bash
npm install -g patchworks
```

## Usage

### Create a new project from a template

```bash
# Create a new project based on a template repository
patchworks create https://github.com/original/template my-project

# Specify a branch other than 'main'
patchworks create https://github.com/original/template my-project --branch develop
```

This will:

- Clone the template repository to your specified directory
- Set up tracking information for future updates

## License

MIT
