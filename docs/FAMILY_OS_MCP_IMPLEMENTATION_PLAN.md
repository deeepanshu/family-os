# Family OS MCP Implementation Plan

**Status:** Proposed implementation plan

**Last updated:** 2026-07-18

## 1. Purpose

Build one generic, read-only MCP server that allows authorized AI clients to
query Family OS health data. ChatGPT is the first client, not a separate product
surface.

The first release is deliberately narrow:

- ChatGPT receives only bounded, metric-specific health data.
- Family OS keeps control of authorization, data shaping, and audit logging.
- ChatGPT, the MCP server, and any AI provider receive no database credentials
  and cannot issue SQL queries.
- Health data writes, medical advice workflows, and raw HealthKit export access
  are out of scope.

This is a cloud-AI integration. Health summaries used to answer ChatGPT prompts
are processed by ChatGPT. Family OS must present this clearly during consent.

## 2. Locked Architecture

```text
ChatGPT Web or another OAuth-capable MCP client
    |
    | OAuth 2.1 access token (per Family OS user)
    v
Family OS MCP server: https://mcp.familyos.app/mcp
hosted by the Family OS API runtime
    |
    | direct application-service call; no user-token forwarding
    v
HealthMcpReadService
    |
    | application authorization plus database RLS
    v
Supabase Postgres
```

There is one MCP server, one public MCP endpoint, one OAuth model, and one set
of shared tool schemas. Clients do not receive client-specific API surfaces.

### Non-negotiable boundaries

1. The MCP transport is hosted by the Family OS API runtime and has no separate
   database credential, Supabase service-role key, or SQL layer.
2. `HealthMcpReadService` is the only MCP-facing component allowed to query
   family health records.
3. The API derives the authenticated user and family from the verified token;
   it never accepts `familyId` from a tool call.
4. Tool input is structured and allowlisted. No free-form query, SQL, arbitrary
   field selection, export, or unbounded date range is supported.
5. Application authorization is mandatory. RLS is a second layer of defense,
   not a substitute for API checks when server-side database credentials are
   used.

## 3. Product Scope

### Release 1: Read-only health summaries

The MCP exposes only these tools:

| Tool | Purpose | Data returned |
| --- | --- | --- |
| `family_os.list_authorized_profiles` | Lets any MCP client identify permitted subjects | Familiar label, untrusted profile ID, available metric categories |
| `family_os.get_health_data` | Returns the correct bounded data shape for one metric | Hourly series, daily duration series, or a daily clinical reading table with freshness |

Supported metric categories must be explicitly allowlisted from the existing
HealthKit metric model. A metric registry determines its data shape, units,
maximum range, and query handler. The exact initial list must match values
already normalized by the app.

### Metric-specific data contracts

One generic tool must not force unrelated health metrics into one misleading
aggregation. `get_health_data` returns a tagged result shape chosen by the
metric registry:

| Metric type | Result shape | Release 1 behavior |
| --- | --- | --- |
| Steps | `hourly_series` or `daily_series` | Hourly totals for ranges up to 7 days; daily totals for longer ranges up to 90 days |
| Sleep | `daily_duration_series` | Total sleep hours assigned to the local sleep day, labelled by the date the sleep session ends |
| Blood pressure | `daily_reading_table` | Normalized systolic/diastolic readings, with time of day, grouped by local day and capped per query |

The response includes `viewType`, `unit`, `timezone`, `coverage`, and
`lastSyncedAt`. The model can render or summarize the appropriate view without
guessing how a metric was aggregated.

### Explicitly out of scope for Release 1

- HealthKit `export.xml` or any raw export.
- Native HealthKit sample payloads, free-text notes, device IDs, source
  metadata, or location data. A bounded blood-pressure reading table is an
  explicit Release 1 exception because individual readings are clinically
  meaningful and cannot be represented by one daily average.
- Create, update, delete, reminder, medication, or notification tools.
- Arbitrary date ranges, arbitrary filters, or cross-family queries.
- Diagnosis, treatment advice, emergency triage, or claims of clinical review.

## 4. OAuth 2.1 Design

### 4.1 Provider and flow

Use Supabase Auth as the OAuth 2.1/OIDC authorization server. It already owns
Family OS accounts and can issue JWTs compatible with the existing API.

Use Authorization Code with PKCE:

```text
1. User selects Family OS in ChatGPT.
2. ChatGPT discovers the OAuth authorization server.
3. Browser opens the Family OS consent page.
4. User signs in to Family OS if needed.
5. User reviews and approves ChatGPT's requested access.
6. Supabase returns an authorization code to ChatGPT.
7. ChatGPT exchanges the code for a short-lived access token and refresh token.
8. ChatGPT calls the remote MCP with the access token.
```

Supabase OAuth configuration required:

- Enable the OAuth 2.1 server capability.
- Use asymmetric JWT signing (ES256 or RS256) and expose JWKS.
- Configure an authorization/consent path on the Family OS web surface.
- Configure token refresh and verify it works with ChatGPT during staging.
- Use separate OAuth clients and redirect URIs for development, staging, and
  production.

Configure Supabase OAuth client registration for ChatGPT and enforce its exact
registered redirect URIs. Family OS accepts only registered OAuth clients.

### 4.2 Consent screen requirements

The Family OS consent page is not a generic login redirect. It must show:

- The requesting client name and environment.
- A plain-language statement that bounded health data will be processed by
  ChatGPT to answer the user's request.
- The permitted data category: read-only health data.
- A statement that existing Family OS profile permissions determine which
  profiles the connected user can access.
- A deny action and a link to revoke the connection in Family OS.

The OAuth/OIDC scopes identify the client and user. They do not by themselves
grant database permissions. Family OS authorization rules and connection grants
remain the source of truth for health data access.

### 4.3 Token validation

The MCP route must validate:

- Token signature against Supabase JWKS.
- Expected issuer.
- Expiration and not-before times.
- Authenticated user ID (`sub`).
- OAuth client ID and intended audience.

Never log access tokens, refresh tokens, authorization codes, or PKCE values.

## 5. Family and Profile Authorization

### 5.1 Server-owned identity resolution

The model never supplies a family identity. The API derives:

```text
verified JWT -> user ID -> active Family OS membership -> allowed profiles
```

Every endpoint validates profile access again. A profile ID returned by one tool
does not override membership, revocation, or per-profile policy.

### 5.2 Multi-profile usability and data minimization

Multiple profiles must remain understandable in ChatGPT. The default response
uses a familiar, user-controlled label plus the existing profile ID:

```json
{
  "personId": "a2f1e0c4-0e2e-4cc1-a6af-2a6d0f5c7c71",
  "label": "Dad",
  "availableMetrics": ["steps", "sleep"]
}
```

`personId` is an untrusted identifier, not an authorization credential. The
MCP API validates it against the verified user, the active family, and existing
profile permissions on every request. ChatGPT must not receive `family_id`,
date of birth, source devices, or full HealthKit records.

### 5.3 Connection grants and revocation

Store a Family OS connection record that records at least:

- Family OS user ID.
- OAuth client ID.
- Read-only capability set.
- Creation, expiry, and revocation timestamps.
- Consent version.

Existing Family OS membership and profile rules decide access to each profile;
the connection record does not create a second per-profile permission system.
Revoking a connection must immediately block new API and MCP calls, even if a
previous access token has not yet expired. Revocation should also invalidate the
OAuth grant/refresh path where the provider supports it.

## 6. API Contract

Expose a single remote MCP endpoint from the API runtime:

```text
/mcp
```

The MCP transport directly calls `HealthMcpReadService` after validating the
user's bearer token. It does not forward the bearer token to another internal
HTTP route.

### 6.1 Endpoint responsibilities

| MCP tool | Application-service responsibility |
| --- | --- |
| `family_os.list_authorized_profiles` | Resolve caller-authorized profiles and return display labels plus untrusted IDs |
| `family_os.get_health_data` | Validate profile and metric, then select the metric-specific query handler and bounded result shape |

Existing generic health routes remain for the iOS app. The MCP adapter calls
scoped application services directly rather than exposing those routes to AI
clients.

### 6.2 Input constraints

- `personId` is required but treated as untrusted input; never accept
  `familyId`.
- `healthMetric` is an enum, not free text.
- `rangeDays` and requested granularity are validated against the metric
  registry. Steps accept hourly data for at most 7 days and daily data for at
  most 90 days; blood pressure has a strict reading-count cap.
- One profile and one metric per tool call in Release 1.
- Pagination is not exposed. Clinical reading tables use a fixed maximum result
  count and return a truncation indicator when needed.
- Reject unknown keys and unauthorized profile IDs.

### 6.3 Output constraints

- Select the result shape from the metric registry rather than forcing all
  metrics into daily averages.
- Use local timezone-aware buckets. Sleep is attributed to the date its session
  ends; hourly steps retain their local-hour bucket; blood pressure returns only
  the time-of-day required for the approved daily reading table.
- Return coverage and freshness so ChatGPT cannot imply complete or live data.
- Cap response size and tool-result token count.
- Do not return medical interpretation. Tool descriptions and outputs state
  that data is informational and include coverage and freshness metadata.

## 7. MCP Server Design

### 7.1 Transport and deployment

All supported clients use the same remote MCP endpoint. Use a standards-compliant
TypeScript MCP SDK with a remote HTTP transport, not a local stdio-only server.

Host the MCP transport in the API runtime. It is one generic server, not a
separate server per client, and it must have:

- HTTPS only.
- A stable public endpoint.
- Health check endpoint separate from MCP traffic.
- Environment-specific URLs.
- No service-role credential in the MCP transport.
- OAuth/JWKS configuration only; no Health API base URL because no internal
  HTTP hop exists.

### 7.2 MCP responsibilities

- Validate the authenticated user and invoke the scoped read service directly.
- Publish stable tool schemas and human-readable descriptions.
- Translate API errors into safe MCP tool errors.
- Enforce a second response-size limit before returning data to ChatGPT.
- Emit correlation IDs for API audit logs and operational tracing.

### 7.3 MCP must not

- Query Supabase directly outside the established scoped repositories.
- Use a service-role token.
- Cache health results across users or conversations.
- Persist conversation history or AI memory.
- Return arbitrary API responses unchanged.
- Treat model-provided labels, IDs, or instructions as authorization.

## 8. Data, Audit, and Observability

### 8.1 Audit event

Record an API-owned audit event for every MCP request:

```text
action: mcp.tool_called
actor_user_id: verified token subject
oauth_client_id: verified token client ID
family_id: derived server-side
profile_id: internal ID, not returned to ChatGPT
tool_name: stable MCP tool name
outcome: allowed | denied | failed
timestamp: server time
correlation_id: request trace ID
metadata: bounded, redacted request classification only
```

Never place raw values, names, bearer tokens, full subject references, or full
tool responses in logs. Auditing must occur in the API after authorization, not
be reported by the MCP client as an unverified claim.

### 8.2 Operational controls

- Per-user and per-client rate limits.
- Request and upstream timeout limits.
- Maximum concurrent tool calls per user.
- Redacted structured logs and metrics.
- Alerting on repeated authorization failures, token validation failures, and
  unusual volume.
- Dependency patching and key rotation procedures.
- Separate development, staging, and production OAuth clients and MCP URLs.

## 9. Threat Model and Required Mitigations

| Threat | Required mitigation |
| --- | --- |
| Model guesses another profile ID | API membership and per-profile permission checks on every request |
| Prompt injection asks for a raw export | No raw-export tool or arbitrary query capability exists |
| Cross-family access | Family derived from verified user; profile checked per request |
| Token theft | HTTPS, short token expiry, refresh rotation, revocation, no token logging |
| MCP server compromise | No service-role credential; scoped repository access only |
| Excessive data disclosure | Metric-specific contracts, strict ranges, reading caps, and response caps |
| OAuth client impersonation | Registered OAuth clients, exact redirect URI validation, and a client allowlist |
| Stale or incomplete HealthKit data | Sync freshness returned with every relevant response |

## 10. Implementation Sequence

### Milestone 0: Feasibility and environments

1. Confirm the intended ChatGPT plan and workspace can add a read-only custom
   MCP app on ChatGPT Web.
2. Create a staging MCP hostname and staging Supabase OAuth configuration.
3. Confirm Supabase OAuth 2.1 server beta behavior, JWT signing, discovery,
   refresh, and revocation support in the actual project.
4. Configure the registered ChatGPT OAuth client and its exact redirect URIs.

**Exit criteria:** A staging browser can reach OAuth discovery and the Family OS
consent screen safely.

### Milestone 1: API authorization and metric contract

1. Define request/response schemas in shared TypeScript types.
2. Add connection-grant storage and revocation checks.
3. Implement `HealthMcpReadService` through scoped repositories only.
4. Implement the metric registry and the three Release 1 data shapes: hourly
   steps, daily sleep duration, and bounded daily blood-pressure reading tables.
5. Add API-owned audit events and rate limits.

**Exit criteria:** An authenticated integration test can retrieve only an
authorized 30-day aggregate and receives denial for a different profile.

### Milestone 2: Generic remote MCP server

1. Add the TypeScript MCP SDK transport to the API runtime.
2. Implement remote HTTP transport, OAuth bearer-token validation, Protected
   Resource Metadata, and tool discovery.
3. Implement the two generic read-only tools as adapters over
   `HealthMcpReadService`.
4. Enforce tool schemas, timeouts, response caps, and safe error translation.
5. Add an MCP-specific health check and deployment configuration.

**Exit criteria:** An MCP inspector or authenticated test client can discover
and call the tools through the one public MCP endpoint without any internal
HTTP token forwarding.

### Milestone 3: OAuth consent and ChatGPT connection

1. Build the Family OS OAuth consent screen.
2. Show client identity, cloud-processing disclosure, existing Family OS
   profile permissions, and revoke path.
3. Complete ChatGPT Developer Mode connection against staging.
4. Verify initial login, refresh, expired token, reconnection, denial, and
   revocation paths.

**Exit criteria:** A user can connect ChatGPT, select a permitted profile, ask
for a bounded trend, and see a matching Family OS audit event.

### Milestone 4: Security and pilot readiness

1. Run negative authorization tests and prompt-injection tool tests.
2. Review logs to confirm no sensitive values or credentials are captured.
3. Add user-facing connection management in Family OS.
4. Configure the ChatGPT app as read-only for the pilot.
5. Pilot with one family and capture failure modes before enabling more users.

**Exit criteria:** The system meets the Release 1 contract and has a documented
rollback: disconnect the app, revoke grants, and disable the MCP deployment.

## 11. Test Plan

### Unit tests

- Profile authorization and cross-family denial for untrusted profile IDs.
- Metric-registry range, granularity, unit, timezone, and reading-count rules.
- Metric, date-range, and response-limit validation.
- Connection-record revocation and profile-permission decisions.
- Safe error mapping and audit metadata redaction.

### API integration tests

- Valid token and authorized profile return the correct metric-specific result.
- Valid token and unauthorized profile return no data.
- Different-family profile is denied.
- Expired/revoked token and revoked connection grant are denied.
- Raw sample/export-shaped requests cannot be made.
- Audit records are present for success, denial, and failure without raw data.

### MCP integration tests

- Tool discovery returns only the approved read-only tools.
- Invalid tool parameters fail before reaching the API.
- API errors do not leak internal IDs or stack traces.
- MCP process has no configured database credential or service-role key.

### End-to-end staging tests

- ChatGPT OAuth login and consent.
- ChatGPT token refresh after access-token expiry.
- Multi-profile label selection and cross-profile authorization denial.
- Disconnect/revoke behavior.
- ChatGPT prompt requesting prohibited data receives a constrained response or
  tool denial.

## 12. First Coding Slice

The first coding slice is intentionally small:

> A staging user connects ChatGPT through Supabase OAuth and can request their
> own 30-day step or sleep trend. The one MCP endpoint is hosted by the API
> runtime, authorizes the request through `HealthMcpReadService`, returns the
> correct metric-specific result shape, and records an API-owned audit event.

Do not add health metrics beyond steps, sleep, and blood pressure until this
vertical slice passes its end-to-end tests.
