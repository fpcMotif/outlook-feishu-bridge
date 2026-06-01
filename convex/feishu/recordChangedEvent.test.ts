// Unit tests for the PURE Feishu Event Subscription receiver helpers (ADR-0020).
// These exercise the url_verification handshake, X-Lark-Signature verification,
// Encrypt-Key AES-256-CBC decryption (round-tripped with Web Crypto), and the
// record-change extraction — all without a Convex runtime.

import { describe, expect, it } from "vitest";

import {
  BITABLE_RECORD_CHANGED_EVENT,
  classifyFeishuPayload,
  decryptFeishuEnvelope,
  parseFeishuEventRequest,
  sha256Hex,
  verifyLarkSignature,
  type FeishuEventHeaders,
} from "./recordChangedEvent";

const ENCRYPT_KEY = "test_encrypt_key_123";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCodePoint(b);
  return btoa(binary);
}

// Encrypt exactly the way Feishu does (key = SHA256(encryptKey), random IV,
// AES-256-CBC, base64(iv || ciphertext)) so the decrypt path is round-tripped.
async function encryptForTest(plaintext: string, encryptKey: string): Promise<string> {
  const keyDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", keyDigest, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

function signedHeaders(
  timestamp: string,
  nonce: string,
  signature: string,
): FeishuEventHeaders {
  return { timestamp, nonce, signature };
}

describe("sha256Hex (known-answer vectors)", () => {
  it("matches the canonical SHA-256 of the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('matches the canonical SHA-256 of "abc"', async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("classifyFeishuPayload", () => {
  it("recognizes the url_verification handshake", () => {
    expect(
      classifyFeishuPayload({ type: "url_verification", challenge: "abc123", token: "t" }),
    ).toEqual({ kind: "challenge", challenge: "abc123" });
  });

  it("extracts create/update/delete changes from a record-change event", () => {
    const result = classifyFeishuPayload({
      schema: "2.0",
      header: { event_type: BITABLE_RECORD_CHANGED_EVENT, token: "t" },
      event: {
        file_token: "bascnFile",
        table_id: "tbl4TE2GV472sKzp",
        action_list: [
          { record_id: "rec_new", action: "record_added" },
          { record_id: "rec_chg", action: "record_edited" },
          { record_id: "rec_gone", action: "record_deleted" },
        ],
      },
    });
    expect(result).toEqual({
      kind: "recordChanged",
      tableId: "tbl4TE2GV472sKzp",
      fileToken: "bascnFile",
      changes: [
        { recordId: "rec_new", action: "record_added" },
        { recordId: "rec_chg", action: "record_edited" },
        { recordId: "rec_gone", action: "record_deleted" },
      ],
    });
  });

  it("ignores action_list entries with an unknown action or no record_id", () => {
    const result = classifyFeishuPayload({
      header: { event_type: BITABLE_RECORD_CHANGED_EVENT },
      event: {
        table_id: "tbl1",
        action_list: [
          { record_id: "rec_ok", action: "record_edited" },
          { record_id: "rec_weird", action: "record_unknown_op" },
          { action: "record_added" },
        ],
      },
    });
    expect(result).toMatchObject({
      kind: "recordChanged",
      changes: [{ recordId: "rec_ok", action: "record_edited" }],
    });
  });

  it("ignores unrelated event types (e.g. the directory contact.user.updated_v3)", () => {
    expect(
      classifyFeishuPayload({ header: { event_type: "contact.user.updated_v3" }, event: {} }),
    ).toEqual({ kind: "ignored", reason: "event_type=contact.user.updated_v3" });
  });

  it("ignores a non-object payload", () => {
    expect(classifyFeishuPayload(null)).toEqual({ kind: "ignored", reason: "non-object payload" });
  });
});

describe("verifyLarkSignature", () => {
  it("accepts a correctly computed SHA256(timestamp+nonce+encryptKey+body) signature", async () => {
    const timestamp = "1700000000";
    const nonce = "nonce123";
    const rawBody = '{"hello":"world"}';
    const signature = await sha256Hex(timestamp + nonce + ENCRYPT_KEY + rawBody);
    expect(
      await verifyLarkSignature({
        headers: signedHeaders(timestamp, nonce, signature),
        encryptKey: ENCRYPT_KEY,
        rawBody,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const timestamp = "1700000000";
    const nonce = "nonce123";
    const signature = await sha256Hex(timestamp + nonce + ENCRYPT_KEY + '{"hello":"world"}');
    expect(
      await verifyLarkSignature({
        headers: signedHeaders(timestamp, nonce, signature),
        encryptKey: ENCRYPT_KEY,
        rawBody: '{"hello":"TAMPERED"}',
      }),
    ).toBe(false);
  });

  it("rejects when signature headers are missing", async () => {
    expect(
      await verifyLarkSignature({
        headers: { timestamp: null, nonce: null, signature: null },
        encryptKey: ENCRYPT_KEY,
        rawBody: "{}",
      }),
    ).toBe(false);
  });
});

describe("decryptFeishuEnvelope", () => {
  it("round-trips an AES-256-CBC Encrypt-Key envelope back to plaintext", async () => {
    const plaintext = JSON.stringify({ type: "url_verification", challenge: "round-trip-ok" });
    const encrypt = await encryptForTest(plaintext, ENCRYPT_KEY);
    expect(await decryptFeishuEnvelope(encrypt, ENCRYPT_KEY)).toBe(plaintext);
  });
});

describe("parseFeishuEventRequest", () => {
  const noHeaders: FeishuEventHeaders = { timestamp: null, nonce: null, signature: null };

  it("answers a plaintext challenge when no Encrypt Key is configured", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "echo-me", token: "t" });
    expect(await parseFeishuEventRequest({ rawBody, headers: noHeaders })).toEqual({
      kind: "challenge",
      challenge: "echo-me",
    });
  });

  it("verifies the signature and extracts changes for a signed plaintext event", async () => {
    const rawBody = JSON.stringify({
      header: { event_type: BITABLE_RECORD_CHANGED_EVENT },
      event: { table_id: "tbl1", action_list: [{ record_id: "rec_x", action: "record_deleted" }] },
    });
    const timestamp = "1700000001";
    const nonce = "n2";
    const signature = await sha256Hex(timestamp + nonce + ENCRYPT_KEY + rawBody);
    const result = await parseFeishuEventRequest({
      rawBody,
      headers: signedHeaders(timestamp, nonce, signature),
      encryptKey: ENCRYPT_KEY,
    });
    expect(result).toMatchObject({
      kind: "recordChanged",
      tableId: "tbl1",
      changes: [{ recordId: "rec_x", action: "record_deleted" }],
    });
  });

  it("rejects a request whose signature does not verify", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "should-not-echo" });
    const result = await parseFeishuEventRequest({
      rawBody,
      headers: signedHeaders("1700000002", "n3", "deadbeef"),
      encryptKey: ENCRYPT_KEY,
    });
    expect(result).toEqual({ kind: "ignored", reason: "signature verification failed" });
  });

  it("decrypts a signed, Encrypt-Key-enveloped challenge", async () => {
    const inner = JSON.stringify({ type: "url_verification", challenge: "decrypted-echo" });
    const encrypt = await encryptForTest(inner, ENCRYPT_KEY);
    const rawBody = JSON.stringify({ encrypt });
    const timestamp = "1700000003";
    const nonce = "n4";
    const signature = await sha256Hex(timestamp + nonce + ENCRYPT_KEY + rawBody);
    const result = await parseFeishuEventRequest({
      rawBody,
      headers: signedHeaders(timestamp, nonce, signature),
      encryptKey: ENCRYPT_KEY,
    });
    expect(result).toEqual({ kind: "challenge", challenge: "decrypted-echo" });
  });

  it("rejects a payload whose verification token does not match", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "x", token: "wrong" });
    const result = await parseFeishuEventRequest({
      rawBody,
      headers: noHeaders,
      verificationToken: "expected-token",
    });
    expect(result).toEqual({ kind: "ignored", reason: "verification token mismatch" });
  });
});
