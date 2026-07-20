import type { AppConfig } from "../config";
import { HttpError } from "../errors";

export type SupabaseOAuthClientInfo = {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris?: string[];
};

export type SupabaseAuthorizationDetails = {
  authorization_id: string;
  client: SupabaseOAuthClientInfo;
  redirect_uri?: string;
  scope?: string;
  /** Present when consent was already granted and the user should be redirected. */
  redirect_url?: string;
};

export type SupabaseConsentResult = {
  redirect_url: string;
};

export type SupabaseOAuthClient = {
  getAuthorizationDetails(accessToken: string, authorizationId: string): Promise<SupabaseAuthorizationDetails>;
  approveAuthorization(accessToken: string, authorizationId: string): Promise<SupabaseConsentResult>;
  denyAuthorization(accessToken: string, authorizationId: string): Promise<SupabaseConsentResult>;
};

/**
 * Thin HTTP client for Supabase Auth OAuth authorization APIs used by the consent page.
 * Paths mirror supabase-js GoTrueClient._getAuthorizationDetails / _approveAuthorization.
 */
export function createSupabaseOAuthClient(config: AppConfig, fetchImpl: typeof fetch = fetch): SupabaseOAuthClient {
  const baseUrl = config.SUPABASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    throw new HttpError(500, "oauth_not_configured", "SUPABASE_URL is required for OAuth consent.");
  }
  const authBase = `${baseUrl}/auth/v1`;
  const apikey = config.SUPABASE_ANON_KEY;

  async function authRequest<T>(
    accessToken: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json"
    };
    if (apikey) {
      headers.apikey = apikey;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetchImpl(`${authBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      const message =
        typeof payload === "object" &&
        payload !== null &&
        "msg" in payload &&
        typeof (payload as { msg: unknown }).msg === "string"
          ? (payload as { msg: string }).msg
          : typeof payload === "object" &&
              payload !== null &&
              "error_description" in payload &&
              typeof (payload as { error_description: unknown }).error_description === "string"
            ? (payload as { error_description: string }).error_description
            : typeof payload === "object" &&
                payload !== null &&
                "message" in payload &&
                typeof (payload as { message: unknown }).message === "string"
              ? (payload as { message: string }).message
              : `Supabase OAuth request failed (${response.status}).`;
      throw new HttpError(response.status === 401 ? 401 : 400, "oauth_authorization_error", message);
    }

    return payload as T;
  }

  return {
    async getAuthorizationDetails(accessToken, authorizationId) {
      const data = await authRequest<Record<string, unknown>>(
        accessToken,
        "GET",
        `/oauth/authorizations/${encodeURIComponent(authorizationId)}`
      );
      return normalizeAuthorizationDetails(data, authorizationId);
    },

    async approveAuthorization(accessToken, authorizationId) {
      const data = await authRequest<{ redirect_url?: string }>(
        accessToken,
        "POST",
        `/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`,
        { action: "approve" }
      );
      return requireRedirectUrl(data);
    },

    async denyAuthorization(accessToken, authorizationId) {
      const data = await authRequest<{ redirect_url?: string }>(
        accessToken,
        "POST",
        `/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`,
        { action: "deny" }
      );
      return requireRedirectUrl(data);
    }
  };
}

function requireRedirectUrl(data: { redirect_url?: string }): SupabaseConsentResult {
  if (!data.redirect_url || typeof data.redirect_url !== "string") {
    throw new HttpError(500, "oauth_authorization_error", "Supabase consent response was missing redirect_url.");
  }
  return { redirect_url: data.redirect_url };
}

function normalizeAuthorizationDetails(
  data: Record<string, unknown>,
  authorizationId: string
): SupabaseAuthorizationDetails {
  // Already-consented responses may only include redirect_url.
  if (typeof data.redirect_url === "string" && !data.client && !data.authorization_id) {
    return {
      authorization_id: authorizationId,
      client: { client_id: "" },
      redirect_url: data.redirect_url
    };
  }

  const clientRaw = data.client;
  if (!clientRaw || typeof clientRaw !== "object") {
    throw new HttpError(400, "oauth_authorization_error", "Authorization details did not include client information.");
  }
  const client = clientRaw as Record<string, unknown>;
  const clientId = typeof client.client_id === "string" ? client.client_id : "";
  if (!clientId && typeof data.redirect_url !== "string") {
    throw new HttpError(400, "oauth_authorization_error", "Authorization details did not include OAuth client_id.");
  }

  return {
    authorization_id:
      typeof data.authorization_id === "string" ? data.authorization_id : authorizationId,
    client: {
      client_id: clientId,
      client_name: typeof client.client_name === "string" ? client.client_name : undefined,
      client_uri: typeof client.client_uri === "string" ? client.client_uri : undefined,
      logo_uri: typeof client.logo_uri === "string" ? client.logo_uri : undefined,
      redirect_uris: Array.isArray(client.redirect_uris)
        ? client.redirect_uris.filter((u): u is string => typeof u === "string")
        : undefined
    },
    redirect_uri: typeof data.redirect_uri === "string" ? data.redirect_uri : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    redirect_url: typeof data.redirect_url === "string" ? data.redirect_url : undefined
  };
}
