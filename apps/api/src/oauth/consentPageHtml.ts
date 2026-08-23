import type { AppConfig } from "../config";
import { escapeHtml } from "../html";
import { mcpOAuthPath } from "../mcp/publicUrl";

/**
 * Server-rendered OAuth consent UI for Supabase OAuth 2.1.
 * The page authenticates via Supabase JS, then calls Family OS consent APIs
 * so the connection grant is created server-side from verified authorization details.
 */
export function renderOAuthConsentPage(config: AppConfig): string {
  const supabaseUrl = config.SUPABASE_URL ?? "";
  const supabaseAnonKey = config.SUPABASE_ANON_KEY ?? "";
  const resourceName = config.MCP_RESOURCE_NAME;
  const oauthPath = mcpOAuthPath(config);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize ${escapeHtml(resourceName)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e7ecf3;
      --muted: #9aa7b8;
      --accent: #3b82f6;
      --danger: #ef4444;
      --border: #2a3648;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(1200px 600px at 20% -10%, #1e3a5f 0%, transparent 55%), var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: min(440px, 100%);
      background: color-mix(in srgb, var(--card) 92%, black);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
    }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    p { color: var(--muted); line-height: 1.5; margin: 0 0 14px; }
    .label { font-size: .85rem; color: var(--muted); margin-bottom: 4px; }
    .value { font-weight: 600; margin-bottom: 12px; word-break: break-word; }
    ul { margin: 0 0 16px; padding-left: 1.2rem; color: var(--muted); }
    li { margin: 4px 0; }
    .row { display: flex; gap: 10px; margin-top: 18px; }
    button {
      flex: 1;
      border: 0;
      border-radius: 10px;
      padding: 12px 14px;
      font-weight: 600;
      font-size: .95rem;
      cursor: pointer;
    }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .approve { background: var(--accent); color: white; }
    .deny { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .error {
      background: color-mix(in srgb, var(--danger) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
      color: #fecaca;
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 14px;
      font-size: .9rem;
    }
    .status { color: var(--muted); font-size: .9rem; margin-bottom: 12px; }
    input[type="email"] {
      width: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #0c1118;
      color: var(--text);
      padding: 12px;
      margin-bottom: 10px;
      font-size: 1rem;
    }
    .hint { font-size: .8rem; color: var(--muted); }
  </style>
</head>
<body>
  <main class="card">
    <div class="status" id="status">Loading…</div>
    <div id="content"></div>
  </main>
  <script type="module">
    const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
    const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};
    const RESOURCE_NAME = ${JSON.stringify(resourceName)};
    const OAUTH_PATH = ${JSON.stringify(oauthPath)};

    const statusEl = document.getElementById("status");
    const contentEl = document.getElementById("content");
    const params = new URLSearchParams(window.location.search);
    const authorizationId = params.get("authorization_id");

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function setStatus(text) {
      statusEl.textContent = text || "";
    }

    function showError(message) {
      contentEl.innerHTML = '<div class="error"></div>';
      contentEl.querySelector(".error").textContent = message;
    }

    if (!authorizationId) {
      setStatus("");
      showError("Missing authorization_id. Open this page from the OAuth authorization redirect.");
      throw new Error("missing authorization_id");
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setStatus("");
      showError("OAuth consent is not configured (SUPABASE_URL / SUPABASE_ANON_KEY).");
      throw new Error("supabase not configured");
    }

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    async function accessToken() {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return data.session?.access_token ?? null;
    }

    async function api(path, options = {}) {
      const token = await accessToken();
      if (!token) {
        const err = new Error("not_authenticated");
        err.code = "not_authenticated";
        throw err;
      }
      const response = await fetch(path, {
        ...options,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
          ...(options.headers || {})
        }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body?.error?.message || ("Request failed (" + response.status + ")");
        const err = new Error(message);
        err.status = response.status;
        throw err;
      }
      return body;
    }

    function renderLogin() {
      setStatus("Sign in to FamilyStack to continue");
      contentEl.innerHTML =
        "<h1>Connect an AI client</h1>" +
        "<p>Sign in with the same FamilyStack account that owns your health profiles. A one-time magic link will be emailed to you.</p>" +
        '<label class="label" for="email">Email</label>' +
        '<input id="email" type="email" autocomplete="email" placeholder="you@example.com" />' +
        '<div class="row"><button class="approve" id="send-link" type="button">Email magic link</button></div>' +
        '<p class="hint">After clicking the link in your email, return to this tab if it does not reopen automatically.</p>';

      document.getElementById("send-link").onclick = async () => {
        const email = document.getElementById("email").value.trim();
        if (!email) {
          showError("Enter your email address.");
          return;
        }
        setStatus("Sending magic link…");
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.href }
        });
        if (error) {
          setStatus("");
          showError(error.message);
          return;
        }
        setStatus("Check your email for the magic link, then return here.");
      };
    }

    function renderConsent(details) {
      const clientName = details.client?.client_name || details.client?.client_id || "Unknown client";
      const scopes = (details.scope || "").split(/\\s+/).filter(Boolean);
      setStatus("Review this connection request");

      let html =
        "<h1>Authorize " + escapeHtml(clientName) + "</h1>" +
        "<p><strong>" + escapeHtml(clientName) + "</strong> wants read-only access to FamilyStack health data through " +
        escapeHtml(RESOURCE_NAME) + ".</p>" +
        '<div class="label">What will be shared</div>' +
        "<ul>" +
        "<li>Read-only health summaries (steps, sleep, blood pressure) for profiles you can already access in FamilyStack</li>" +
        "<li>Data may be processed by the AI client (for example ChatGPT) to answer your questions</li>" +
        "<li>No write access, no medical advice, no raw HealthKit export</li>" +
        "</ul>" +
        '<div class="label">Client</div>' +
        '<div class="value">' + escapeHtml(clientName) + "</div>";

      if (details.redirect_uri) {
        html +=
          '<div class="label">Redirect URI</div>' +
          '<div class="value">' + escapeHtml(details.redirect_uri) + "</div>";
      }
      if (scopes.length) {
        html +=
          '<div class="label">Requested OAuth scopes</div><ul>' +
          scopes.map((s) => "<li>" + escapeHtml(s) + "</li>").join("") +
          "</ul>";
      }
      html +=
        '<p class="hint">You can revoke this connection later from FamilyStack. Approving creates a FamilyStack connection grant for this OAuth client only.</p>' +
        '<div class="row">' +
        '<button class="deny" id="deny" type="button">Deny</button>' +
        '<button class="approve" id="approve" type="button">Approve</button>' +
        "</div>";
      contentEl.innerHTML = html;

      async function decide(decision) {
        document.getElementById("approve").disabled = true;
        document.getElementById("deny").disabled = true;
        setStatus(decision === "approve" ? "Approving…" : "Denying…");
        try {
          const body = await api(OAUTH_PATH + "/consent/decision", {
            method: "POST",
            body: JSON.stringify({ authorizationId, decision })
          });
          const redirectUrl = body?.data?.redirectUrl;
          if (!redirectUrl) {
            throw new Error("Missing redirect URL from consent decision.");
          }
          window.location.assign(redirectUrl);
        } catch (error) {
          setStatus("");
          showError(error.message || "Consent decision failed.");
        }
      }

      document.getElementById("approve").onclick = () => decide("approve");
      document.getElementById("deny").onclick = () => decide("deny");
    }

    async function boot() {
      const {
        data: { session }
      } = await supabase.auth.getSession();
      if (!session) {
        renderLogin();
        return;
      }

      setStatus("Loading authorization request…");
      try {
        const body = await api(
          OAUTH_PATH + "/consent/details?authorization_id=" + encodeURIComponent(authorizationId)
        );
        const details = body.data;
        if (details.redirectUrl && !details.client?.clientId) {
          window.location.assign(details.redirectUrl);
          return;
        }
        renderConsent({
          client: {
            client_id: details.client.clientId,
            client_name: details.client.clientName
          },
          redirect_uri: details.redirectUri,
          scope: details.scope
        });
      } catch (error) {
        if (error.code === "not_authenticated" || error.status === 401) {
          renderLogin();
          return;
        }
        setStatus("");
        showError(error.message || "Failed to load authorization details.");
      }
    }

    boot();
  </script>
</body>
</html>`;
}
