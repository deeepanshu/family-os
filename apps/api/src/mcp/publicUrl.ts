import { DEFAULT_MCP_PUBLIC_PATH, type AppConfig } from "../config";

/**
 * Public origin that hosts MCP (scheme + host, no path).
 * Example: https://familyos.deepanshujain.me
 */
export function mcpPublicOrigin(config: AppConfig): string {
  if (config.MCP_PUBLIC_ORIGIN) {
    return config.MCP_PUBLIC_ORIGIN.replace(/\/$/, "");
  }
  return `http://127.0.0.1:${config.PORT}`;
}

/**
 * Public path of the MCP endpoint, always starting with `/`.
 * Example: /health/api/mcp
 */
export function mcpPublicPath(config: AppConfig): string {
  const path = config.MCP_PUBLIC_PATH || DEFAULT_MCP_PUBLIC_PATH;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/$/, "") || DEFAULT_MCP_PUBLIC_PATH;
}

/**
 * Canonical MCP resource URL used as the OAuth resource indicator / JWT audience.
 * Example: https://familyos.deepanshujain.me/health/api/mcp
 */
export function mcpResourceUrl(config: AppConfig): string {
  return `${mcpPublicOrigin(config)}${mcpPublicPath(config)}`;
}

/**
 * Protected Resource Metadata URL per RFC 9728 path insertion.
 * For resource https://origin/health/api/mcp the metadata is at
 * https://origin/.well-known/oauth-protected-resource/health/api/mcp
 */
export function mcpProtectedResourceMetadataUrl(config: AppConfig): string {
  return `${mcpPublicOrigin(config)}/.well-known/oauth-protected-resource${mcpPublicPath(config)}`;
}

/** OAuth consent path colocated with the canonical MCP resource. */
export function mcpOAuthPath(config: AppConfig): string {
  const path = mcpPublicPath(config);
  if (!path.endsWith("/mcp")) {
    throw new Error("MCP_PUBLIC_PATH must end with /mcp so the OAuth consent path can be derived.");
  }
  return `${path.slice(0, -"/mcp".length)}/oauth`;
}

/** @deprecated Use mcpPublicOrigin + mcpPublicPath. Kept for callers that need the resource origin only. */
export function mcpPublicBaseUrl(config: AppConfig): string {
  return mcpPublicOrigin(config);
}
