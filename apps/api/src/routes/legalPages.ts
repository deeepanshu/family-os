import { Hono } from "hono";
import type { AppConfig } from "../config";
import { escapeHtml } from "../html";
import { mcpPublicOrigin } from "../mcp/publicUrl";

export const SUPPORT_EMAIL = "support@deepanshujain.me";

const EFFECTIVE_DATE = "August 23, 2026";


function legalPage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · FamilyStack</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e7ecf3;
      --muted: #9aa7b8;
      --accent: #3b82f6;
      --border: #2a3648;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(1200px 600px at 20% -10%, #1e3a5f 0%, transparent 55%), var(--bg);
      color: var(--text);
      padding: 24px 16px 48px;
    }
    main {
      width: min(720px, 100%);
      margin: 0 auto;
      background: color-mix(in srgb, var(--card) 92%, black);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
    }
    nav { font-size: .9rem; margin: 0 0 20px; }
    nav a { color: var(--accent); text-decoration: none; margin-right: 14px; }
    nav a:hover { text-decoration: underline; }
    h1 { font-size: 1.6rem; margin: 0 0 8px; }
    h2 { font-size: 1.15rem; margin: 28px 0 8px; }
    p, li { color: var(--muted); line-height: 1.55; }
    p { margin: 0 0 12px; }
    ul { margin: 0 0 14px; padding-left: 1.2rem; }
    li { margin: 4px 0; }
    .meta { font-size: .85rem; color: var(--muted); margin-bottom: 20px; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <main>
    <nav>
      <a href="/privacy">Privacy</a>
      <a href="/support">Support</a>
      <a href="/account-deletion">Delete account</a>
    </nav>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

export function renderPrivacyPolicyPage(origin: string): string {
  return legalPage(
    "Privacy Policy",
    `<p class="meta">Effective ${EFFECTIVE_DATE}. Product name: FamilyStack.</p>
<p>FamilyStack is a household health app. This policy describes how the iOS app and the FamilyStack API at ${escapeHtml(origin)} handle information. It matches shipped behavior, not future features.</p>

<h2>Who we are</h2>
<p>FamilyStack is operated by Deepanshu Jain. Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. See also <a href="/support">Support</a>.</p>

<h2>Information we collect</h2>
<ul>
  <li><strong>Account.</strong> Sign in with Apple through Supabase Auth. We store your Auth user id and, when Apple provides it, an email address. We do not receive your Apple password.</li>
  <li><strong>Profile.</strong> Display name, optional relationship label, and optional date of birth that you enter.</li>
  <li><strong>Health data you choose to import.</strong> FamilyStack <em>reads</em> from Apple Health (HealthKit). It does not write readings back to Apple Health. This release imports only:
    <ul>
      <li>Activity — step count</li>
      <li>Vitals — blood pressure (systolic/diastolic) and heart rate (including resting heart rate)</li>
      <li>Sleep — sleep analysis</li>
      <li>Workouts — session metadata (type, start/end, duration, active energy, distance, heart-rate summary, source/device, indoor flag, elevation, average METs, flights climbed, pause/lap events, and multi-sport segments), plus swimming distance and stroke count when present. For strength workouts you can add exercise names, reps, and optional weights. We do not import GPS routes or per-second workout series.</li>
    </ul>
  </li>
  <li><strong>Not a product metric.</strong> Blood glucose / blood sugar is not an implemented FamilyStack metric. The app does not request or present glucose as a product feature.</li>
  <li><strong>Household.</strong> Family name, membership, and pending invites you create so relatives can join.</li>
  <li><strong>Reminders.</strong> Reminder content, schedule, and recipients you configure.</li>
  <li><strong>Device notifications.</strong> If you opt in, the app uses on-device local notifications for HealthKit sync alerts. This release does not register for remote (APNs) notifications or upload a device token.</li>
  <li><strong>Optional assistant access.</strong> If you approve an OAuth consent for a third-party assistant (for example ChatGPT via MCP), we store that connection grant. The approved assistant can read stored steps, blood pressure, sleep, and workout data for profiles you are already allowed to see, including other household Self profiles. Strength-workout exercise entries (name, reps, optional weight) can be included. The assistant receives this data and handles it under its own privacy terms.</li>
  <li><strong>Diagnostics.</strong> Firebase Crashlytics receives crash and non-fatal reports. Reports may include a stable user id (UUID only — never email), operational stage names, and error codes. They do not include health readings, tokens, free-text notes, or raw sample payloads.</li>
</ul>

<h2>How we use information</h2>
<ul>
  <li>Show you and your household their imported health history in FamilyStack.</li>
  <li>Sync HealthKit on the schedule and metric groups you enable.</li>
  <li>Show local HealthKit-sync alerts you opted into.</li>
  <li>Authenticate you and keep the household together.</li>
  <li>Honor an assistant connection you explicitly approved, until you revoke it or delete your account.</li>
  <li>Diagnose crashes and keep the service reliable.</li>
</ul>
<p>We do not use your information for advertising. We do not sell personal data. We do not use health data for marketing or third-party advertising. We do not track you across other companies’ apps or websites for ads.</p>

<h2>Family sharing</h2>
<p>When you join or create a household, other active members of that household can see your profile and the health readings imported for your Self profile. They cannot see your Sign in with Apple credentials. Leaving the household or deleting your account hides you and your readings from former members.</p>

<h2>Where data is stored</h2>
<p>Account, profile, household, reminder, assistant-grant, and imported health records are stored on FamilyStack servers (Supabase Postgres, reached through the API on this host). Apple Health data remains on your device unless you enable HealthKit import. Pending HealthKit operations sit in a local queue on this iPhone until they sync. Crash diagnostics are processed by Google Firebase Crashlytics.</p>

<h2>Retention</h2>
<p>We keep your developer records while your account is active. When you delete your account, we remove the records listed on the <a href="/account-deletion">account deletion</a> page, including the on-device HealthKit sync queue. Audit log rows (including <code>account.deleted</code>) are retained for security and abuse prevention and do not contain health values or tokens. Health data that stays in Apple Health on your device is not a FamilyStack record and is not deleted by us.</p>

<h2>Your choices</h2>
<ul>
  <li>Decline or later revoke HealthKit access in iOS Settings → Health → Data Access &amp; Devices → FamilyStack. The app then stops reading those types.</li>
  <li>Turn off individual HealthKit groups in Profile.</li>
  <li>Revoke an assistant connection in the app’s connection list, or delete your account.</li>
  <li>Sign out, or delete your account as described at <a href="/account-deletion">Delete your account</a> (also the User Privacy Choices page).</li>
  <li>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for access or deletion help.</li>
</ul>

<h2>Children</h2>
<p>FamilyStack is a household app. A parent or guardian manages the Apple ID used to sign in. We do not use children’s data for advertising.</p>

<h2>Changes</h2>
<p>If this policy changes, we will update this page and the effective date. Continued use after an update means you accept the revised policy.</p>

<p>Contact: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> · <a href="/support">Support</a> · <a href="/account-deletion">Delete account</a></p>`
  );
}

export function renderSupportPage(): string {
  return legalPage(
    "Support",
    `<p class="meta">FamilyStack help and contact.</p>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for account, HealthKit sync, household invite, or privacy questions. We read this inbox; there is no in-app chat.</p>
<p>Include the Apple ID email you used to sign in if you can, and a short description of what you need. Do not send health readings or screenshots that show medical values unless they are required to debug a problem.</p>
<h2>Useful links</h2>
<ul>
  <li><a href="/privacy">Privacy Policy</a></li>
  <li><a href="/account-deletion">Delete your account</a> (User Privacy Choices)</li>
</ul>
<p>FamilyStack iOS app · bundle id <code>com.deepanshujain.familyos</code></p>`
  );
}

export function renderAccountDeletionPage(): string {
  return legalPage(
    "Delete your account",
    `<p class="meta">User Privacy Choices for FamilyStack. Effective ${EFFECTIVE_DATE}.</p>
<p>You can delete your FamilyStack account from the app. This is a full account deletion, not the household profile “inactive” action.</p>

<h2>How to delete in the app</h2>
<ol>
  <li>Open FamilyStack and sign in.</li>
  <li>Go to <strong>Profile</strong>.</li>
  <li>Tap <strong>Delete account</strong>.</li>
  <li>Confirm the destructive prompt. The app calls the signed-in delete API, then wipes the on-device HealthKit sync store (Application Support/HealthKitSync/sync.sqlite, including pending operations, sync configuration, and group state) and clears local session tokens and the HealthKit installation id from the keychain.</li>
</ol>
<p>If you cannot open the app, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from the address associated with your Sign in with Apple account and ask us to delete it.</p>

<h2>What is removed</h2>
<ul>
  <li>Your Sign in with Apple / Supabase Auth identity and sessions.</li>
  <li>Your Self profile (<code>people</code> row).</li>
  <li>Your household membership. If you were the last member, the household is dissolved the same way as deleting the current family; other people’s remaining health is not wiped as a side effect.</li>
  <li>Health records keyed to your Self profile (steps, sleep, daily metrics, blood pressure, any blood-glucose rows if present, workouts and exercise/set children).</li>
  <li>HealthKit install, settings, sync state, groups, and operation receipts for your profile on the server.</li>
  <li>The on-device FamilyStack HealthKit sync queue (pending operations, sync configuration, and group state).</li>
  <li>Assistant / MCP connection grants you approved.</li>
  <li>Reminders you created, plus their recipient and delivery rows.</li>
  <li>Pending household invites you created.</li>
  <li>Your recipient rows on other people’s reminders.</li>
</ul>
<p>After deletion, former household members cannot see you or your readings. Signing in again with the same Apple ID starts a new empty FamilyStack account. Previous FamilyStack records stay deleted.</p>

<h2>What is retained</h2>
<ul>
  <li><strong>Audit logs</strong>, including an <code>account.deleted</code> row written before identity is wiped. These rows use the existing audit shape (action, resource, actor id if still present, metadata without health values or tokens). They are kept for security and are not cascade-deleted.</li>
  <li>Other members’ profiles, health, devices, grants, and reminders they own.</li>
  <li>The shared workout exercise catalog (not user-owned).</li>
  <li>Historical accepted, revoked, or expired invites you created. Pending invites are removed.</li>
  <li>Apple Health data on your iPhone. FamilyStack only reads HealthKit; deleting the account does not delete Apple Health samples on the device.</li>
</ul>

<p>Deleting a household profile (setting it inactive) is a different action and does not delete your Auth account. Use <strong>Delete account</strong> for privacy choices.</p>
<p><a href="/privacy">Privacy Policy</a> · <a href="/support">Support</a></p>`
  );
}

export function createLegalPageRoutes(config: AppConfig) {
  const legal = new Hono();
  const origin = mcpPublicOrigin(config);

  legal.get("/privacy", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(renderPrivacyPolicyPage(origin));
  });
  legal.get("/privacy-policy", (c) => c.redirect("/privacy", 302));
  legal.get("/support", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(renderSupportPage());
  });
  legal.get("/account-deletion", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(renderAccountDeletionPage());
  });

  return legal;
}
