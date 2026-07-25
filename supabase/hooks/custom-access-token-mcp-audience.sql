-- Custom Access Token Hook: set JWT audience for OAuth-issued MCP tokens.
--
-- Supabase OAuth access tokens default to aud: "authenticated". Family OS MCP
-- validates tokens against the MCP resource URL (RFC 8707 resource indicator):
--   https://familyos.deepanshujain.me/health/api/mcp
--
-- Without this hook, ChatGPT receives valid Supabase tokens that the MCP
-- server correctly rejects for wrong audience.
--
-- Audience rewrite vs client allowlist:
-- This hook sets aud for any OAuth token that includes client_id (including
-- clients registered via Dynamic Client Registration). That is intentional:
-- JWT audience only selects the MCP resource. Family OS still requires:
--   1. MCP_ALLOWED_OAUTH_CLIENT_IDS allowlist (consent + tool checks)
--   2. An active mcp_connection_grants row for (user_id, oauth_client_id)
-- A non-allowlisted client can obtain a Supabase token with MCP aud but cannot
-- create a grant or call health tools.
--
-- Deploy:
-- 1. Supabase Dashboard → Authentication → Hooks → Custom Access Token
--    (or enable via config.toml / Management API)
-- 2. Point the hook at this Postgres function (or the equivalent Edge Function)
-- 3. Replace the MCP resource URL below if your public origin/path differs
-- 4. Issue a fresh OAuth token and confirm aud matches the MCP resource URL
-- 5. Prefer disabling Dynamic Client Registration in production, or monitor
--    registered clients (https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
--
-- Docs:
--   https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook
--   https://supabase.com/docs/guides/auth/oauth-server/token-security

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  claims jsonb;
  client_id text;
  -- Must match mcpResourceUrl() / MCP_PUBLIC_ORIGIN + MCP_PUBLIC_PATH in production.
  mcp_resource_aud constant text := 'https://familyos.deepanshujain.me/health/api/mcp';
begin
  claims := event->'claims';
  client_id := claims->>'client_id';

  -- OAuth server tokens (and refreshes of those sessions) include client_id.
  -- Leave regular app session tokens as aud = authenticated for the Health API.
  -- Allowlisting is enforced in the Family OS API, not in this hook.
  if client_id is not null and length(trim(client_id)) > 0 then
    claims := jsonb_set(claims, '{aud}', to_jsonb(mcp_resource_aud));
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

-- Auth admin must be able to execute the hook.
grant execute
  on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

revoke execute
  on function public.custom_access_token_hook(jsonb)
  from authenticated, anon, public;

grant usage on schema public to supabase_auth_admin;
