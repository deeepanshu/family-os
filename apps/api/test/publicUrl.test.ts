import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  mcpProtectedResourceMetadataUrl,
  mcpPublicOrigin,
  mcpPublicPath,
  mcpResourceUrl
} from "../src/mcp/publicUrl";

describe("mcp public URL helpers", () => {
  it("models origin plus path for resource and RFC 9728 metadata URLs", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
      MCP_PUBLIC_PATH: "/api/mcp"
    });

    expect(mcpPublicOrigin(config)).toBe("https://familyos.deepanshujain.me");
    expect(mcpPublicPath(config)).toBe("/api/mcp");
    expect(mcpResourceUrl(config)).toBe("https://familyos.deepanshujain.me/api/mcp");
    expect(mcpProtectedResourceMetadataUrl(config)).toBe(
      "https://familyos.deepanshujain.me/.well-known/oauth-protected-resource/api/mcp"
    );
  });

  it("defaults local origin to loopback when unset", () => {
    const config = loadConfig({ NODE_ENV: "test", PORT: 3001 });
    expect(mcpResourceUrl(config)).toBe("http://127.0.0.1:3001/api/mcp");
    expect(mcpProtectedResourceMetadataUrl(config)).toBe(
      "http://127.0.0.1:3001/.well-known/oauth-protected-resource/api/mcp"
    );
  });
});
