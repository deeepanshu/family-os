import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createSupabaseOAuthClient } from "../src/oauth/supabaseOAuth";

describe("Supabase OAuth client", () => {
  it("normalizes the current Supabase client id and name fields", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key"
    });
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe("https://project.supabase.co/auth/v1/oauth/authorizations/auth-request");
      return new Response(
        JSON.stringify({
          authorization_id: "auth-request",
          client: { id: "chatgpt-client", name: "ChatGPT" },
          redirect_uri: "https://chatgpt.com/connector/oauth/callback",
          scope: "openid"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const details = await createSupabaseOAuthClient(config, fetchImpl).getAuthorizationDetails(
      "user-access-token",
      "auth-request"
    );

    expect(details.client).toEqual({ client_id: "chatgpt-client", client_name: "ChatGPT" });
  });
});
