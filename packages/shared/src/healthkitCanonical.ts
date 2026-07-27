/**
 * Append-only canonical serializers for HealthKit sync digests.
 * Both server and client must produce identical byte sequences for the same inputs.
 * Never reorder, rename, or reinterpret existing fields; only append new kinds.
 */

export const HEALTHKIT_EVENT_CANONICAL_PREFIX = "familyos.healthkit.event" as const;
export const HEALTHKIT_SCOPE_MANIFEST_PREFIX = "familyos.healthkit.scope" as const;
/** Unit separator (ASCII 0x1f). */
export const HEALTHKIT_US = "\u001f";

/** Stable JSON: sorted object keys, no spaces, omit undefined/null optional empties carefully. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = sortKeys(v);
  }
  return out;
}

export type CanonicalHealthEventInput = {
  eventId: string;
  entityKey: string;
  entityVersion: number;
  group: string;
  scopeKey: string;
  op: "upsert" | "delete";
  sessionId?: string | null;
  /** Already-validated payload object, or null/undefined for deletes. */
  payload?: unknown | null;
};

/**
 * Canonical UTF-8 string used as the input to SHA-256 for server fingerprints.
 * Layout (US-separated):
 *   prefix | eventId | entityKey | entityVersion | group | scopeKey | op | sessionId|"" | payloadJson|""
 */
export function canonicalHealthEventString(input: CanonicalHealthEventInput): string {
  const session = input.sessionId ?? "";
  const payloadPart =
    input.op === "delete" || input.payload === null || input.payload === undefined
      ? ""
      : canonicalJson(input.payload);
  return [
    HEALTHKIT_EVENT_CANONICAL_PREFIX,
    normalizeUuid(input.eventId),
    input.entityKey,
    String(input.entityVersion),
    input.group,
    nfc(input.scopeKey),
    input.op,
    session === "" ? "" : normalizeUuid(session),
    payloadPart
  ].join(HEALTHKIT_US);
}

/**
 * Scope manifest proof string (pre-hash).
 * Layout (US-separated):
 *   prefix | sessionId | scopeKey | eventCountDecimal | sortedEventIds...
 */
export function canonicalScopeManifestString(input: {
  sessionId: string;
  scopeKey: string;
  eventIds: string[];
}): string {
  const ids = [...new Set(input.eventIds.map(normalizeUuid))].sort();
  const count = String(ids.length);
  return [
    HEALTHKIT_SCOPE_MANIFEST_PREFIX,
    normalizeUuid(input.sessionId),
    nfc(input.scopeKey),
    count,
    ...ids
  ].join(HEALTHKIT_US);
}

function nfc(value: string): string {
  return value.normalize("NFC");
}

/** Lowercase canonical UUID ASCII. */
export function normalizeUuid(value: string): string {
  return value.trim().toLowerCase();
}

/** Hex SHA-256 of a UTF-8 string. Caller supplies the hash implementation. */
export function sha256HexFromUtf8(
  utf8: string,
  sha256: (data: Uint8Array) => Uint8Array | ArrayBuffer
): string {
  const bytes = new TextEncoder().encode(utf8);
  const digest = sha256(bytes);
  const arr = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
