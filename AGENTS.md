# Agent Execution Model

Codex is the orchestrator for this project. OpenCode is a worker tool that Codex may use to offload bounded analysis, review, or implementation tasks.

## Roles

- Codex owns task framing, sequencing, final implementation decisions, verification, and commits.
- OpenCode `thinker` uses `opencode-go/glm-5.2` for planning, repo survey, architecture, and research.
- OpenCode `reviewer` uses `openai/gpt-5.5` for read-only review of diffs, plans, and implementation risks.
- OpenCode `coder` uses `opencode-go/kimi-k2.7-code` for tightly scoped implementation tasks only.

## Operating Rules

- Prefer Codex for edits unless a task is explicitly delegated to the OpenCode coder.
- Treat OpenCode output as advisory until Codex verifies it against the repo.
- Keep OpenCode tasks narrow, with a clear expected output.
- Do not let worker agents commit, push, reset, clean, or rewrite unrelated files.
- Do not include secrets or `.env` contents in worker prompts.
- Preserve user changes. Do not revert unrelated worktree changes.

## Typical Flow

1. Codex inspects the repo and defines the next slice.
2. Codex may ask OpenCode `thinker` for planning or research.
3. Codex may ask OpenCode `coder` to implement a bounded piece, or implement directly.
4. Codex verifies changes locally.
5. Codex may ask OpenCode `reviewer` to review the diff.
6. Codex applies final judgment, fixes issues, and commits only when requested.

## OpenCode Usage

Run worker tasks from the repo root:

```sh
opencode run --agent thinker "Plan the smallest backend bootstrap slice."
opencode run --agent reviewer "Review the current git diff for bugs and missing tests."
opencode run --agent coder "Implement only the healthcheck endpoint skeleton."
```

