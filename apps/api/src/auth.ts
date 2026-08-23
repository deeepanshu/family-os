import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "./config";
import { HttpError } from "./errors";

export type AuthUser = {
  id: string;
  email?: string;
  oauthClientId?: string;
};

export type AppVariables = {
  config: AppConfig;
  user: AuthUser;
};

export type VerifiedAuth = {
  userId: string;
  email?: string;
  oauthClientId?: string;
};

export type VerifyBearerOptions = {
  audience: string | string[];
  requireOAuthClientId?: boolean;
};

const bearerPrefix = "Bearer ";
const hmacAlgorithms = new Set(["HS256", "HS384", "HS512"]);
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function requireAuth() {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const config = c.get("config");
    const header = c.req.header("authorization");
    if (!header?.startsWith(bearerPrefix)) {
      throw new HttpError(401, "missing_authorization", "Authorization bearer token is required.");
    }

    const token = header.slice(bearerPrefix.length).trim();
    if (!token) {
      throw new HttpError(401, "missing_authorization", "Authorization bearer token is required.");
    }

    const verified = await verifyBearerToken(token, config, { audience: "authenticated" });
    c.set("user", {
      id: verified.userId,
      email: verified.email,
      oauthClientId: verified.oauthClientId
    });
    await next();
  });
}

export async function verifyBearerToken(
  token: string,
  config: AppConfig,
  options: VerifyBearerOptions
): Promise<VerifiedAuth> {
  if (
    config.NODE_ENV !== "production" &&
    config.HEALTH_API_ENABLE_DEV_AUTH &&
    config.HEALTH_API_DEV_AUTH_USER_ID &&
    token === "dev-token"
  ) {
    return {
      userId: config.HEALTH_API_DEV_AUTH_USER_ID,
      oauthClientId: config.HEALTH_API_MCP_DEV_OAUTH_CLIENT_ID
    };
  }

  const issuer = config.SUPABASE_URL ? `${config.SUPABASE_URL}/auth/v1` : undefined;
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch (error) {
    logTokenVerificationFailure(token, error);
    throw new HttpError(401, "invalid_token", "Bearer token could not be verified.");
  }

  if (!config.SUPABASE_JWT_SECRET && (!issuer || hmacAlgorithms.has(alg ?? ""))) {
    throw new HttpError(500, "auth_not_configured", "Supabase JWT verification is not configured.");
  }

  try {
    const verifyOptions = { issuer, audience: options.audience };
    const { payload } = hmacAlgorithms.has(alg ?? "")
      ? await jwtVerify(token, new TextEncoder().encode(config.SUPABASE_JWT_SECRET), verifyOptions)
      : await jwtVerify(token, jwksForIssuer(issuer!), verifyOptions);
    if (!payload.sub) {
      throw new HttpError(401, "invalid_token", "Token subject is required.");
    }
    if (payload.role !== undefined && payload.role !== "authenticated") {
      throw new HttpError(401, "invalid_token", "Token role must be authenticated.");
    }

    const oauthClientId = extractOAuthClientId(payload);
    if (options.requireOAuthClientId && !oauthClientId) {
      throw new HttpError(401, "invalid_token", "Token is missing OAuth client identity.");
    }

    return {
      userId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      oauthClientId
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    logTokenVerificationFailure(token, error);
    throw new HttpError(401, "invalid_token", "Bearer token could not be verified.");
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader?.startsWith(bearerPrefix)) {
    return null;
  }
  const token = authorizationHeader.slice(bearerPrefix.length).trim();
  return token || null;
}

function extractOAuthClientId(payload: JWTPayload): string | undefined {
  if (typeof payload.client_id === "string" && payload.client_id.length > 0) {
    return payload.client_id;
  }
  if (typeof payload.azp === "string" && payload.azp.length > 0) {
    return payload.azp;
  }
  return undefined;
}

function jwksForIssuer(issuer: string) {
  const cached = jwksByIssuer.get(issuer);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

function logTokenVerificationFailure(token: string, error: unknown) {
  try {
    const header = decodeProtectedHeader(token);
    const claims = decodeJwt(token);
    console.warn(
      JSON.stringify({
        event: "auth_token_verification_failed",
        alg: header.alg,
        kid: typeof header.kid === "string" ? "present" : "missing",
        iss: claims.iss,
        aud: claims.aud,
        role: claims.role,
        hasSub: Boolean(claims.sub),
        error: error instanceof Error ? error.message : String(error)
      })
    );
  } catch {
    console.warn(
      JSON.stringify({
        event: "auth_token_verification_failed",
        parseable: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}
