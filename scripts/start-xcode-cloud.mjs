#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ASC = "https://api.appstoreconnect.apple.com";

const WORKFLOWS = {
  testflight: {
    id: "367FA404-8D98-4F7B-A133-A9E1929A82C8",
    name: "Release TestFlight",
  },
  "app-store": {
    id: "47172e26-3833-4bcd-8891-12c2b610006f",
    name: "App Store Release",
  },
};

const REQUIRED_SECRETS = [
  "APP_STORE_CONNECT_ISSUER_ID",
  "APP_STORE_CONNECT_KEY_ID",
  "APP_STORE_CONNECT_PRIVATE_KEY",
];

function fail(message) {
  throw new Error(message);
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function normalizePem(raw) {
  let key = String(raw).trim();
  if (key.includes("\\n")) {
    key = key.replace(/\\n/g, "\n");
  }
  if (!key.includes("BEGIN")) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
  }
  return key;
}

function signJwt({ issuerId, keyId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  };
  const pem =
    typeof privateKey === "string"
      ? privateKey
      : privateKey.export({ type: "pkcs8", format: "pem" });
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("SHA256", Buffer.from(signingInput), {
    key: pem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(signature)}`;
}

async function asc(token, path, { method = "GET", body } = {}) {
  const url = path.startsWith("http") ? path : `${ASC}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const details = (json?.errors || [])
      .map((error) => error.detail || error.title || JSON.stringify(error))
      .join("; ");
    fail(
      `App Store Connect ${method} ${url} failed (${response.status}): ${details || text}`,
    );
  }
  return json;
}

async function listGitReferences(token, repositoryId, extraQuery = "") {
  let path =
    `/v1/scmRepositories/${repositoryId}/gitReferences?limit=200${extraQuery}`;
  const refs = [];
  while (path) {
    const page = await asc(token, path);
    refs.push(...(page.data || []));
    path = page.links?.next || null;
  }
  return refs;
}

async function findGitReference(token, repositoryId, canonicalName) {
  const encoded = encodeURIComponent(canonicalName);
  try {
    const filtered = await listGitReferences(
      token,
      repositoryId,
      `&filter[canonicalName]=${encoded}`,
    );
    const match = filtered.find(
      (ref) => ref.attributes?.canonicalName === canonicalName,
    );
    if (match) {
      return match;
    }
  } catch (error) {
    console.log(`canonicalName filter failed; listing git references (${error.message})`);
  }
  const all = await listGitReferences(token, repositoryId);
  return all.find((ref) => ref.attributes?.canonicalName === canonicalName) || null;
}

async function waitForGitReference(token, repositoryId, canonicalName) {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ref = await findGitReference(token, repositoryId, canonicalName);
    if (ref) {
      return ref;
    }
    if (attempt === attempts) {
      break;
    }
    console.log(
      `Xcode Cloud does not yet know ${canonicalName}; retrying (${attempt}/${attempts})`,
    );
    await delay(10_000);
  }
  fail(
    `Xcode Cloud has no git reference ${canonicalName}. Push the branch and re-run after Cloud fetches it.`,
  );
}

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function summarize(lines) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) {
    return;
  }
  fs.appendFileSync(summary, `${lines.join("\n")}\n`);
}

function selfCheck() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const token = signJwt({
    issuerId: "00000000-0000-0000-0000-000000000000",
    keyId: "SELFCHECK",
    privateKey,
  });
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  const ok = crypto.verify(
    "SHA256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    {
      key: publicKey.export({ type: "spki", format: "pem" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signatureB64, "base64url"),
  );
  if (!ok) {
    fail("JWT self-check failed");
  }
  console.log("start-xcode-cloud self-check ok");
}

async function main() {
  if (process.argv.includes("--self-check")) {
    selfCheck();
    return;
  }

  const target = env("XCODE_CLOUD_TARGET");
  const gitRef = env("GIT_REF");
  const gitSha = env("GIT_SHA");
  const requireMain = env("REQUIRE_MAIN") === "1";
  const workflow = WORKFLOWS[target];

  if (!workflow) {
    fail(`XCODE_CLOUD_TARGET must be testflight or app-store (got ${target || "empty"})`);
  }
  if (!gitRef) {
    fail("GIT_REF is required (refs/heads/<branch>)");
  }
  if (requireMain && gitRef !== "refs/heads/main") {
    fail(`App Store Archive only runs on main (ref=${gitRef})`);
  }

  const missing = REQUIRED_SECRETS.filter((name) => !env(name));
  if (missing.length) {
    fail(
      `Missing GitHub secrets: ${missing.join(", ")}. Add an App Store Connect API key with Xcode Cloud access.`,
    );
  }

  const token = signJwt({
    issuerId: env("APP_STORE_CONNECT_ISSUER_ID"),
    keyId: env("APP_STORE_CONNECT_KEY_ID"),
    privateKey: normalizePem(env("APP_STORE_CONNECT_PRIVATE_KEY")),
  });

  const workflowInfo = await asc(token, `/v1/ciWorkflows/${workflow.id}`);
  const actualName = workflowInfo.data?.attributes?.name;
  if (actualName !== workflow.name) {
    fail(
      `Xcode Cloud workflow ${workflow.id} is named "${actualName}", expected "${workflow.name}"`,
    );
  }

  const repository = await asc(token, `/v1/ciWorkflows/${workflow.id}/repository`);
  const repositoryId = repository.data?.id;
  if (!repositoryId) {
    fail(`No SCM repository on workflow ${workflow.name}`);
  }

  const scmRef = await waitForGitReference(token, repositoryId, gitRef);
  const started = await asc(token, "/v1/ciBuildRuns", {
    method: "POST",
    body: {
      data: {
        type: "ciBuildRuns",
        attributes: { clean: true },
        relationships: {
          workflow: { data: { type: "ciWorkflows", id: workflow.id } },
          sourceBranchOrTag: {
            data: { type: "scmGitReferences", id: scmRef.id },
          },
        },
      },
    },
  });

  const run = started.data;
  const number = run?.attributes?.number;
  const runId = run?.id;
  const sourceSha =
    run?.attributes?.sourceCommit?.commitSha ||
    run?.attributes?.sourceCommit?.sha ||
    "";

  if (gitSha && sourceSha && !sourceSha.toLowerCase().startsWith(gitSha.slice(0, 12).toLowerCase())) {
    fail(
      `Xcode Cloud started ${sourceSha} but GitHub dispatched ${gitSha}. Re-run after Cloud fetches ${gitRef}.`,
    );
  }

  const lines = [
    `Started Xcode Cloud workflow ${workflow.name}`,
    `ref=${gitRef}`,
    gitSha ? `sha=${gitSha}` : null,
    number != null ? `build=${number}` : null,
    runId ? `ciBuildRun=${runId}` : null,
  ].filter(Boolean);

  for (const line of lines) {
    console.log(line);
  }

  summarize([
    `## ${workflow.name}`,
    "",
    `- Ref: \`${gitRef}\``,
    gitSha ? `- SHA: \`${gitSha}\`` : null,
    number != null ? `- Cloud build: \`${number}\`` : null,
    runId ? `- Run id: \`${runId}\`` : null,
    "",
    "Xcode Cloud archives this ref. Watch App Store Connect for processing; GitHub does not wait for the archive.",
  ].filter(Boolean));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
