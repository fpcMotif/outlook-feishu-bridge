// Feishu/Lark Event Subscription receiver helpers for the Bitable record-change
// event (ADR-0020). These are PURE (async) functions — no ctx/db — so signature
// verification, Encrypt-Key decryption, the url_verification handshake, and the
// per-record change extraction are all unit-testable in isolation. The Convex
// httpAction in ../http.ts owns the request/response + scheduling.
//
// They use ONLY Web Crypto (globalThis.crypto.subtle), which is available in the
// Convex runtime (Node's "crypto" module is not). The webhook makes the mirror
// react to source changes in real time — a record_deleted tombstones the Convex
// row instantly instead of waiting for the weekly Mirror Prune, which is what
// keeps the mirror from drifting above the live Customer Table between syncs.
//
// Official sources (open.feishu.cn / open.larksuite.com / official SDK source —
// no third-party wrapper):
//   event:      https://open.feishu.cn/document/docs/bitable-v1/events/bitable_record_changed
//   challenge:  https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case
//   encrypt:    https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
//   signature = SHA256_hex(timestamp + nonce + encryptKey + rawBody)
//   node-sdk:   github.com/larksuite/node-sdk/blob/main/utils/aes-cipher.ts (AES-256-CBC, key=SHA256(encryptKey), IV=first 16 bytes)

// The single wire event_type for Base record create/update/delete (verified
// against five official sources). The audit's "bitable.ui.record.updated_v1" is
// fabricated; "contact.user.updated_v3" is an unrelated directory event.
export const BITABLE_RECORD_CHANGED_EVENT = "drive.file.bitable_record_changed_v1";
export const URL_VERIFICATION = "url_verification";

export type RecordChangeAction = "record_added" | "record_edited" | "record_deleted";

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<RecordChangeAction>([
  "record_added",
  "record_edited",
  "record_deleted",
]);

export interface RecordChange {
  recordId: string;
  action: RecordChangeAction;
}

export type ParsedFeishuRequest =
  | { kind: "challenge"; challenge: string }
  | {
      kind: "recordChanged";
      tableId: string | undefined;
      fileToken: string | undefined;
      changes: RecordChange[];
    }
  | { kind: "ignored"; reason: string };

export interface FeishuEventHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Lower-case hex SHA-256 via Web Crypto.
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Length-checked, non-short-circuit hex compare (avoids leaking position via
// early return). Not bit-for-bit constant time at the JS level, but adequate
// for comparing two hex digests.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let equal = true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) equal = false;
  }
  return equal;
}

// X-Lark-Signature = SHA256_hex(timestamp + nonce + encryptKey + rawBody),
// hashed over the RAW request body bytes (not a re-serialized parse).
export async function verifyLarkSignature(params: {
  headers: FeishuEventHeaders;
  encryptKey: string;
  rawBody: string;
}): Promise<boolean> {
  const { headers, encryptKey, rawBody } = params;
  if (!headers.timestamp || !headers.nonce || !headers.signature) return false;
  const expected = await sha256Hex(headers.timestamp + headers.nonce + encryptKey + rawBody);
  return safeEqual(expected, headers.signature);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}

// Decrypt the Encrypt-Key envelope: key = SHA256(encryptKey) (32 raw bytes);
// buf = base64-decode(encrypt); IV = buf[0:16]; ciphertext = buf[16:];
// AES-256-CBC with PKCS7 padding (Web Crypto strips it).
export async function decryptFeishuEnvelope(encrypt: string, encryptKey: string): Promise<string> {
  const keyDigest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(encryptKey),
  );
  const buffer = base64ToBytes(encrypt);
  const iv = buffer.slice(0, 16);
  const ciphertext = buffer.slice(16);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyDigest,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

function extractChanges(event: Record<string, unknown>): RecordChange[] {
  const actionList = Array.isArray(event.action_list) ? event.action_list : [];
  const changes: RecordChange[] = [];
  for (const item of actionList) {
    if (!isRecord(item)) continue;
    const recordId = typeof item.record_id === "string" ? item.record_id : undefined;
    const action = typeof item.action === "string" ? item.action : undefined;
    // Validate the action against the known enum (the SDK types it as a bare
    // string) — skip + ignore anything unexpected rather than mis-handling it.
    if (recordId && action && KNOWN_ACTIONS.has(action)) {
      changes.push({ recordId, action: action as RecordChangeAction });
    }
  }
  return changes;
}

// Classify an already-decrypted plaintext payload: a url_verification handshake,
// a Bitable record-change event (schema v2 carries the type in header.event_type),
// or something to ignore.
export function classifyFeishuPayload(payload: unknown): ParsedFeishuRequest {
  if (!isRecord(payload)) return { kind: "ignored", reason: "non-object payload" };
  if (payload.type === URL_VERIFICATION && typeof payload.challenge === "string") {
    return { kind: "challenge", challenge: payload.challenge };
  }
  const header = isRecord(payload.header) ? payload.header : undefined;
  const eventType =
    header && typeof header.event_type === "string" ? header.event_type : undefined;
  if (eventType !== BITABLE_RECORD_CHANGED_EVENT) {
    return { kind: "ignored", reason: `event_type=${eventType ?? "(none)"}` };
  }
  const event = isRecord(payload.event) ? payload.event : {};
  return {
    kind: "recordChanged",
    tableId: typeof event.table_id === "string" ? event.table_id : undefined,
    fileToken: typeof event.file_token === "string" ? event.file_token : undefined,
    changes: extractChanges(event),
  };
}

function tokenMatches(payload: unknown, expected: string): boolean {
  if (!isRecord(payload)) return false;
  const bodyToken = typeof payload.token === "string" ? payload.token : undefined;
  const header = isRecord(payload.header) ? payload.header : undefined;
  const headerToken = header && typeof header.token === "string" ? header.token : undefined;
  return bodyToken === expected || headerToken === expected;
}

// Verify (if an Encrypt Key is configured) → decrypt envelope (if present) →
// optional Verification Token check → classify. Returns an "ignored" result
// (never throws) so the httpAction can always answer Feishu with HTTP 200.
export async function parseFeishuEventRequest(input: {
  rawBody: string;
  headers: FeishuEventHeaders;
  encryptKey?: string;
  verificationToken?: string;
}): Promise<ParsedFeishuRequest> {
  const { rawBody, headers, encryptKey, verificationToken } = input;
  if (encryptKey) {
    const ok = await verifyLarkSignature({ headers, encryptKey, rawBody });
    if (!ok) return { kind: "ignored", reason: "signature verification failed" };
  }
  let outer: unknown;
  try {
    outer = JSON.parse(rawBody);
  } catch {
    return { kind: "ignored", reason: "invalid JSON body" };
  }
  let payload: unknown = outer;
  if (isRecord(outer) && typeof outer.encrypt === "string") {
    if (!encryptKey) return { kind: "ignored", reason: "encrypted body but no encrypt key set" };
    let plain: string;
    try {
      plain = await decryptFeishuEnvelope(outer.encrypt, encryptKey);
      payload = JSON.parse(plain);
    } catch {
      return { kind: "ignored", reason: "envelope decrypt/parse failed" };
    }
  }
  if (verificationToken && !tokenMatches(payload, verificationToken)) {
    return { kind: "ignored", reason: "verification token mismatch" };
  }
  return classifyFeishuPayload(payload);
}
