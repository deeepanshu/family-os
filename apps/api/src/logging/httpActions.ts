import { normalizeHttpRoute } from "./otelConfig";

/**
 * Human-readable action names for the request log body.
 * Keys are normalized routes (uuids and numeric ids collapse) joined with the
 * HTTP method, so log lines read as intent, not plumbing:
 * `POST /health/api/v1/families → family_create`.
 *
 * Unmatched routes fall back to `METHOD path`.
 */
const ROUTE_ACTIONS: Record<string, string> = {
  // Healthcheck / surface probes
  "GET /health/api/v1/healthcheck": "healthcheck",
  "GET /health/api/mcp/healthcheck": "mcp_healthcheck",

  // Session / bootstrap / self
  "GET /health/api/v1/me": "session_read",
  "POST /health/api/v1/bootstrap": "bootstrap_read",
  "POST /health/api/v1/me/profile": "self_profile_create",
  "DELETE /health/api/v1/me": "account_delete",

  // Family lifecycle
  "POST /health/api/v1/families": "family_create",
  "GET /health/api/v1/families/current": "family_read",
  "DELETE /health/api/v1/families/current": "family_delete",
  "GET /health/api/v1/families/members": "family_members_list",
  "DELETE /health/api/v1/families/members/:uuid": "family_member_remove",
  "POST /health/api/v1/families/leave": "family_leave",

  // People / profiles
  "GET /health/api/v1/people": "people_list",
  "GET /health/api/v1/people/:uuid": "person_read",
  "POST /health/api/v1/people": "person_create",
  "PATCH /health/api/v1/people/:uuid": "person_update",
  "DELETE /health/api/v1/people/:uuid": "person_delete",

  // Invites
  "POST /health/api/v1/invites": "invite_create",
  "GET /health/api/v1/invites/:uuid": "invite_read",
  "POST /health/api/v1/invites/:uuid/accept": "invite_accept",

  // Readings
  "GET /health/api/v1/readings/blood-pressure": "bp_list",
  "POST /health/api/v1/readings/blood-pressure": "bp_write",
  "GET /health/api/v1/readings/blood-pressure/:uuid": "bp_read",
  "GET /health/api/v1/readings/blood-glucose": "glucose_list",
  "POST /health/api/v1/readings/blood-glucose": "glucose_write",
  "GET /health/api/v1/readings/sleep": "sleep_list",
  "GET /health/api/v1/readings/steps": "steps_list",
  "GET /health/api/v1/readings/heart-rate": "heart_rate_list",
  "GET /health/api/v1/readings/workouts": "workouts_list",
  "PUT /health/api/v1/readings/workouts/:uuid/exercises": "workout_exercises_write",

  // HealthKit sync flow
  "GET /health/api/v1/healthkit/settings": "healthkit_settings_read",
  "PUT /health/api/v1/healthkit/settings": "healthkit_settings_write",
  "POST /health/api/v1/healthkit/ops:batch": "healthkit_ops_batch",
  "POST /health/api/v1/healthkit/groups/:uuid/runs/begin": "healthkit_run_begin",
  "POST /health/api/v1/healthkit/groups/:uuid/runs/complete": "healthkit_run_complete",
  "POST /health/api/v1/healthkit/groups/:uuid/runs/fail": "healthkit_run_fail",
  "POST /health/api/v1/healthkit/groups/:uuid/start-import": "healthkit_import_start",
  "POST /health/api/v1/healthkit/groups/:uuid/ready": "healthkit_group_ready",
  "GET /health/api/v1/healthkit/groups/:uuid/status": "healthkit_status_read",

  // Reminders / devices
  "GET /health/api/v1/reminders": "reminders_list",
  "POST /health/api/v1/reminders": "reminder_create",
  "GET /health/api/v1/reminders/:uuid": "reminder_read",
  "PATCH /health/api/v1/reminders/:uuid": "reminder_update",
  "DELETE /health/api/v1/reminders/:uuid": "reminder_delete",
  "POST /health/api/v1/reminders/:uuid/disable-for-me": "reminder_disable",
  "POST /health/api/v1/devices": "device_register",
  "DELETE /health/api/v1/devices/:uuid": "device_delete",

  // Audit + MCP connections
  "GET /health/api/v1/audit-logs": "audit_logs_read",
  "GET /health/api/v1/mcp/connections": "mcp_connections_list",
  "DELETE /health/api/v1/mcp/connections/:uuid": "mcp_connection_revoke",

  // MCP OAuth consent surface (mounted under /health/api/oauth)
  "GET /health/api/oauth/consent": "mcp_consent_page",
  "GET /health/api/oauth/consent/details": "mcp_consent_details",
  "POST /health/api/oauth/consent/decision": "mcp_consent_decision",

  // MCP protocol + discovery
  "POST /health/api/mcp": "mcp_request",
  "GET /health/api/mcp": "mcp_request",
  "DELETE /health/api/mcp": "mcp_request",
  "GET /.well-known/oauth-protected-resource": "mcp_metadata_read",
  "GET /.well-known/oauth-protected-resource/health/api/mcp": "mcp_metadata_read",
  "GET /.well-known/apple-app-site-association": "aasa_read",

  // Public pages
  "GET /invite/:uuid": "invite_landing_read",
  "GET /privacy": "privacy_page_read",
  "GET /terms": "terms_page_read",
  "GET /support": "support_page_read"
};

/**
 * Action name for a method + path pair. Path is normalized first (uuids and
 * numeric ids collapse) so dynamic segments match the static table above.
 */
export function httpActionName(method: string, rawPath: string): string {
  const route = normalizeHttpRoute(rawPath);
  return ROUTE_ACTIONS[`${method} ${route}`] ?? `${method} ${route}`;
}