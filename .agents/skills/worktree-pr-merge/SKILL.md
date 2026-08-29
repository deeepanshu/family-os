---
name: worktree-pr-merge
description: When working in a git worktree, land changes via a GitHub PR and merge that PR. Never merge into or commit on the local main checkout — other agents may be using it.
---

# Worktree changes land through a PR

If this session's repo is a linked worktree, do not touch the primary `main` checkout.

## Detect a worktree

You are in a worktree when any of these is true:

- `git rev-parse --is-inside-work-tree` is true and `git rev-parse --git-dir` is not `$repo/.git`
- `git worktree list` shows this cwd as a path other than the main checkout
- cwd is under `.worktrees/` or a sibling like `family-os-<topic>`

The primary checkout is the worktree whose path is the canonical repo (here: `/Users/deepanshu/Desktop/projects/family-os`) and is usually on `main`.

## Required landing path

1. Commit on the worktree's current topic branch.
2. `git push -u origin HEAD`.
3. Open a PR against `main` (`gh pr create`).
4. Merge that PR (`gh pr merge`), not a local merge.
5. Do not `git checkout main`, `git merge`, or `git commit` in the primary checkout.

## Hard stops

- Never merge a worktree branch into the local `main` worktree.
- Never stash, reset, or commit leftover files in the primary checkout to "make room" for this work.
- Never port a worktree change by editing files in the primary `main` checkout.
- If `main` in the primary checkout is dirty, leave it. Another agent may own those files.

## If asked to "merge to main"

From the worktree:

```sh
git push -u origin HEAD
gh pr create --base main --fill
gh pr merge --merge
```

If the PR cannot merge cleanly, rebase the topic branch onto `origin/main` **in the worktree**, push, and merge the PR. Still do not use the primary checkout.

## Release after merge

Merging does not ship TestFlight. If the user wants a device build, run
**Actions → TestFlight** on the topic branch (before or after merge) or on
`main` after merge. App Store review archives are **Actions → App Store
Archive** on `main` only. Both runs wait for DJ to approve the GitHub
environment before Xcode Cloud starts. Do not create `release/*` tags or
commit on local `main`.
