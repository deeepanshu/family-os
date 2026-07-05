#!/usr/bin/env sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"

echo "Installing repo-managed git hooks..."
git config core.hooksPath "${repo_root}/scripts/hooks"
echo "Git hooks installed from ${repo_root}/scripts/hooks"
