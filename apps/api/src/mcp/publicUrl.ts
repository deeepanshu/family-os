import type { AppConfig } from "../config";

export function mcpPublicBaseUrl(config: AppConfig): string {
  if (config.MCP_PUBLIC_BASE_URL) {
    return config.MCP_PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  return `http://127.0.0.1:${config.PORT}`;
}

export function mcpResourceUrl(config: AppConfig): string {
  return `${mcpPublicBaseUrl(config)}/mcp`;
}

export function mcpProtectedResourceMetadataUrl(config: AppConfig): string {
  return `${mcpPublicBaseUrl(config)}/.well-known/oauth-protected-resource`;
}
