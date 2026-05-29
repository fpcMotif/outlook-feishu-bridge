// Unit tests for the ctx-injectable, callFeishu-backed helpers in bitable.ts.
// The internalAction WRAPPERS (createServiceRecord/correctServiceRecord/
// listFields) only read process.env + wire ctx->callFeishu and need a live
// Convex runtime, so they are exercised by integration/e2e. The branching
// logic worth pinning is:
//   - matchClientRecordId  : domain -> Customer-Table search -> record_id|null
//   - resolveClientRecordId: override wins, else domain match
//   - logServiceRecordIntake: redacted summary always; verbose dump gated on
//                             BITABLE_DIAG_LOG=1 (PII redaction, ADR-0018)
// We mock ./call so callFeishu is a spy — the helpers pass `ctx` straight
// through to it, so a dummy ctx suffices. The Customer Table is READ-ONLY here
// (search only), per the HARD RULE (ADR-0012).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the transport so callFeishu never touches the network / Convex auth.
const callFeishu = vi.fn();
vi.mock("./call", () => ({
  callFeishu: (...args: unknown[]) => callFeishu(...args),
}));

import {
  matchClientRecordId,
  resolveClientRecordId,
  logServiceRecordIntake,
} from "./bitable";
import type { ServiceRowInput } from "./serviceRow";
import type { ActionCtx } from "../_generated/server";

// The helpers only forward `ctx` to the mocked callFeishu; a marker object lets
// us assert it was passed through unchanged.
const ctx = { _marker: "ctx" } as unknown as ActionCtx;
const APP_TOKEN = "appToken123";
// The Customer table id + domain field bitable.ts searches against (ADR-0012).
const CLIENT_TABLE_ID = "tbl4TE2GV472sKzp";

beforeEach(() => {
  callFeishu.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("matchClientRecordId", () => {
  it("returns null WITHOUT calling Feishu when email is undefined", async () => {
    const result = await matchClientRecordId(ctx, APP_TOKEN, undefined);
    expect(result).toBeNull();
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("returns null WITHOUT calling Feishu when the email has no domain", async () => {
    // emailDomain('user@') -> null (trailing @), so we short-circuit.
    const result = await matchClientRecordId(ctx, APP_TOKEN, "user@");
    expect(result).toBeNull();
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("searches the Customer Table by '域名' and returns items[0].record_id", async () => {
    callFeishu.mockResolvedValueOnce({ items: [{ record_id: "rec_match" }] });
    const result = await matchClientRecordId(ctx, APP_TOKEN, "buyer@Mail.Fenchem.COM");
    expect(result).toBe("rec_match");

    // Assert the request shape against the official search endpoint (ADR-0012).
    expect(callFeishu).toHaveBeenCalledTimes(1);
    const [passedCtx, opts] = callFeishu.mock.calls[0];
    expect(passedCtx).toBe(ctx);
    expect(opts.path).toBe(
      `/bitable/v1/apps/${APP_TOKEN}/tables/${CLIENT_TABLE_ID}/records/search`,
    );
    expect(opts.method).toBe("POST");
    expect(opts.auth).toBe("tenant");
    expect(opts.query).toEqual({ page_size: "1" });
    expect(opts.json).toEqual({
      filter: {
        conjunction: "and",
        // emailDomain lowercases + trims the domain before searching.
        conditions: [{ field_name: "域名", operator: "is", value: ["mail.fenchem.com"] }],
      },
    });
  });

  it("returns null when the search response has no items", async () => {
    callFeishu.mockResolvedValueOnce({});
    expect(await matchClientRecordId(ctx, APP_TOKEN, "x@known.com")).toBeNull();
  });

  it("returns null when the search response items array is empty", async () => {
    callFeishu.mockResolvedValueOnce({ items: [] });
    expect(await matchClientRecordId(ctx, APP_TOKEN, "x@known.com")).toBeNull();
  });
});

describe("resolveClientRecordId", () => {
  it("returns input.clientRecordId verbatim (override wins) without calling Feishu", async () => {
    const input: ServiceRowInput = {
      clientRecordId: "rec_override",
      clientEmail: "buyer@known.com",
    };
    const result = await resolveClientRecordId(ctx, APP_TOKEN, input);
    expect(result).toBe("rec_override");
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("falls through to the domain match when clientRecordId is absent", async () => {
    callFeishu.mockResolvedValueOnce({ items: [{ record_id: "rec_domain" }] });
    const input: ServiceRowInput = { clientEmail: "buyer@known.com" };
    const result = await resolveClientRecordId(ctx, APP_TOKEN, input);
    expect(result).toBe("rec_domain");
    expect(callFeishu).toHaveBeenCalledTimes(1);
    expect(callFeishu.mock.calls[0][1].json.filter.conditions[0].value).toEqual(["known.com"]);
  });

  it("returns null when neither an override nor a domain match exists", async () => {
    // No clientRecordId, no clientEmail -> matchClientRecordId short-circuits.
    const result = await resolveClientRecordId(ctx, APP_TOKEN, {});
    expect(result).toBeNull();
    expect(callFeishu).not.toHaveBeenCalled();
  });
});

describe("logServiceRecordIntake", () => {
  const ORIGINAL_DIAG = process.env.BITABLE_DIAG_LOG;
  beforeEach(() => {
    delete process.env.BITABLE_DIAG_LOG;
  });
  afterEach(() => {
    if (ORIGINAL_DIAG === undefined) delete process.env.BITABLE_DIAG_LOG;
    else process.env.BITABLE_DIAG_LOG = ORIGINAL_DIAG;
  });

  const intake: ServiceRowInput = {
    subject: "Inquiry: bulk L-Carnitine",
    clientEmail: "buyer@known.com",
    clientRecordId: "rec_override",
    dateOfOffer: 1_716_900_000_000,
    emailConversationId: "AAQk_conv",
    initiator: { openId: "ou_init", name: "Florian" },
    selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny" }],
    requestSelections: [
      { requestType: "Quotation", note: "FOB pls" },
      { requestType: "Sample", note: "50g" },
    ],
  };
  const fields = { "Email Subject": "x", "Co Worker": [{ id: "ou_jenny" }] };

  it("always logs a REDACTED summary line carrying counts/keys/lengths, not PII", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake(intake, "rec_override", fields);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    // Redacted summary: counts, flags, lengths, field keys.
    expect(line).toContain("[bitable] createServiceRecord clientLinked=true");
    expect(line).toContain("requests=2");
    expect(line).toContain("coworkers=1");
    expect(line).toContain("hasInitiator=true");
    expect(line).toContain(`subjectLen=${intake.subject!.length}`);
    expect(line).toContain(`convIdLen=${intake.emailConversationId!.length}`);
    expect(line).toContain("fieldKeys=[Email Subject,Co Worker]");
    // PII must NOT appear in the redacted summary.
    expect(line).not.toContain("buyer@known.com");
    expect(line).not.toContain("FOB pls");
    expect(line).not.toContain("Florian");
  });

  it("reports clientLinked=false and zeroed counts when the intake is minimal", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake({}, null, {});
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain("clientLinked=false");
    expect(line).toContain("requests=0");
    expect(line).toContain("coworkers=0");
    expect(line).toContain("hasInitiator=false");
    expect(line).toContain("subjectLen=0");
    expect(line).toContain("convIdLen=0");
    expect(line).toContain("fieldKeys=[]");
  });

  it("does NOT emit the verbose DIAG dump unless BITABLE_DIAG_LOG=1", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake(intake, "rec_override", fields);
    // Only the one redacted summary line — no second verbose line.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("DIAG intake="))).toBe(false);
  });

  it("emits the verbose JSON dump (with PII) when BITABLE_DIAG_LOG=1", () => {
    process.env.BITABLE_DIAG_LOG = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake(intake, "rec_override", fields);

    expect(logSpy).toHaveBeenCalledTimes(2);
    const diag = String(logSpy.mock.calls[1][0]);
    expect(diag).toContain("[bitable] DIAG intake=");
    // The gated dump intentionally carries the raw intake + resolved fields.
    expect(diag).toContain("buyer@known.com");
    expect(diag).toContain("FOB pls");
    expect(diag).toContain('"resolvedClientRecordId":"rec_override"');
    expect(diag).toContain("fields=");
  });

  it("treats BITABLE_DIAG_LOG values other than '1' as off", () => {
    process.env.BITABLE_DIAG_LOG = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake(intake, "rec_override", fields);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
