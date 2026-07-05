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

## Local Run Commands

Run local Postgres with Colima/Docker and apply migrations:

```sh
colima start --cpu 2 --memory 4 --disk 20 --runtime docker
npm run db:up
npm run db:migrate:local
```

Run the local Health API with the local Postgres user and the dev-token smoke-test auth path:

```sh
DATABASE_URL=postgres://family_os:family_os@localhost:5432/family_os \
HEALTH_API_REPOSITORY=postgres \
HEALTH_API_SYNC_LOCAL_AUTH_USERS=true \
HEALTH_API_ENABLE_DEV_AUTH=true \
HEALTH_API_DEV_AUTH_USER_ID=00000000-0000-4000-8000-000000000001 \
npm run api:dev
```

The iOS local dev sign-in uses `Bearer dev-token`; the API maps it to
`HEALTH_API_DEV_AUTH_USER_ID`. This bypass is for local smoke testing only and
must stay disabled in production.

For a physical iPhone, `localhost` means the phone itself. Build with the Mac's
LAN IP in `HEALTH_API_BASE_URL`:

```sh
ipconfig getifaddr en0
```

```sh
xcodebuild \
  -project apps/ios/FamilyOS.xcodeproj \
  -scheme FamilyOS \
  -configuration Debug \
  -destination 'platform=iOS,name=<YOUR_IPHONE_NAME>' \
  DEVELOPMENT_TEAM=<YOUR_APPLE_TEAM_ID> \
  HEALTH_API_BASE_URL=http://<YOUR_MAC_LAN_IP>:3001/health/v1 \
  FAMILY_OS_ENV=local \
  build
```

List connected devices when the destination name is unclear:

```sh
xcrun xctrace list devices
```
