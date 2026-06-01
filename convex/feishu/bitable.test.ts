/* eslint-disable max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callFeishu = vi.fn();
vi.mock("./call", () => ({
  callFeishu: (...args: unknown[]) => callFeishu(...args),
}));

import {
  createServiceRecord,
  logServiceRecordIntake,
  matchClientRecordId,
  resolveClientRecordId,
} from "./bitable";
import type { ServiceRowInput } from "./serviceRow";
import type { ActionCtx } from "../_generated/server";

const ctx = { _marker: "ctx" } as unknown as ActionCtx;
const APP_TOKEN = "appToken123";
const CLIENT_TABLE_ID = "tbl4TE2GV472sKzp";
const SERVICE_TABLE_ID = "tbl_service";

type CreateServiceRecordHandler = (
  ctx: ActionCtx,
  args: {
    subject?: string;
    selectedCoworkers?: { openId: string; name: string }[];
    clientToken?: string;
  },
) => Promise<{ recordId: string }>;

const createServiceRecordHandler = (
  createServiceRecord as unknown as { _handler: CreateServiceRecordHandler }
)._handler;

beforeEach(() => {
  callFeishu.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("matchClientRecordId", () => {
  it("returns null without calling Feishu when no searchable domain exists", async () => {
    await expect(matchClientRecordId(ctx, APP_TOKEN, undefined)).resolves.toBeNull();
    await expect(matchClientRecordId(ctx, APP_TOKEN, "user@")).resolves.toBeNull();
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("searches by domain and returns the immutable API record_id (not the human `Record Id` column)", async () => {
    // The human "Record Id" column diverges from the API id here; the DuplexLink
    // target must be the immutable API record_id (ADR-0020 RC2).
    callFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_api", fields: { "Record Id": [{ text: "rec_match", type: "text" }] } }],
    });

    await expect(matchClientRecordId(ctx, APP_TOKEN, "buyer@Mail.Fenchem.COM")).resolves.toBe("rec_api");

    expect(callFeishu).toHaveBeenCalledTimes(1);
    const [passedCtx, opts] = callFeishu.mock.calls[0];
    expect(passedCtx).toBe(ctx);
    expect(opts.path).toBe(`/bitable/v1/apps/${APP_TOKEN}/tables/${CLIENT_TABLE_ID}/records/search`);
    expect(opts.method).toBe("POST");
    expect(opts.auth).toBe("tenant");
    expect(opts.query).toEqual({ page_size: "1" });
    expect(opts.json).toEqual({
      filter: {
        conjunction: "and",
        conditions: [{ field_name: "域名", operator: "is", value: ["mail.fenchem.com"] }],
      },
    });
  });

  it("returns null when the search has no items", async () => {
    callFeishu.mockResolvedValueOnce({});
    await expect(matchClientRecordId(ctx, APP_TOKEN, "x@known.com")).resolves.toBeNull();
  });

  it("returns the API record_id when the row carries no `Record Id` column", async () => {
    callFeishu.mockResolvedValueOnce({ items: [{ record_id: "rec_api" }] });
    await expect(matchClientRecordId(ctx, APP_TOKEN, "buyer@known.com")).resolves.toBe("rec_api");
  });
});

describe("resolveClientRecordId", () => {
  it("uses the selected customer override without calling Feishu", async () => {
    const input: ServiceRowInput = {
      clientRecordId: "rec_override",
      clientEmail: "buyer@known.com",
    };
    await expect(resolveClientRecordId(ctx, APP_TOKEN, input)).resolves.toBe("rec_override");
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("falls back to the domain match when no override exists", async () => {
    callFeishu.mockResolvedValueOnce({ items: [{ record_id: "rec_domain" }] });
    await expect(resolveClientRecordId(ctx, APP_TOKEN, { clientEmail: "buyer@known.com" })).resolves.toBe("rec_domain");
    expect(callFeishu.mock.calls[0][1].json.filter.conditions[0].value).toEqual(["known.com"]);
  });

  it("drops a dev-fixture record_id so it never becomes a broken Client link", async () => {
    const input: ServiceRowInput = {
      clientRecordId: "dev_fixture_microsoft_customer",
      clientEmail: "buyer@known.com",
    };
    await expect(resolveClientRecordId(ctx, APP_TOKEN, input)).resolves.toBeNull();
    expect(callFeishu).not.toHaveBeenCalled();
  });
});

describe("logServiceRecordIntake", () => {
  const originalDiag = process.env.BITABLE_DIAG_LOG;

  beforeEach(() => {
    delete process.env.BITABLE_DIAG_LOG;
  });

  afterEach(() => {
    if (originalDiag === undefined) delete process.env.BITABLE_DIAG_LOG;
    else process.env.BITABLE_DIAG_LOG = originalDiag;
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

  it("logs a redacted summary by default", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake(intake, "rec_override", fields);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain("clientLinked=true");
    expect(line).toContain("requests=2");
    expect(line).toContain("coworkers=1");
    expect(line).toContain("fieldKeys=[Email Subject,Co Worker]");
    expect(line).not.toContain("buyer@known.com");
    expect(line).not.toContain("FOB pls");
    expect(line).not.toContain("Florian");
  });

  it("emits verbose intake only when BITABLE_DIAG_LOG=1", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServiceRecordIntake(intake, "rec_override", fields);
    expect(logSpy).toHaveBeenCalledTimes(1);

    process.env.BITABLE_DIAG_LOG = "1";
    logServiceRecordIntake(intake, "rec_override", fields);
    expect(logSpy).toHaveBeenCalledTimes(3);
    const diag = String(logSpy.mock.calls[2][0]);
    expect(diag).toContain("[bitable] DIAG intake=");
    expect(diag).toContain("buyer@known.com");
    expect(diag).toContain("FOB pls");
  });
});

describe("createServiceRecord idempotency", () => {
  const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;

  beforeEach(() => {
    process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
    process.env.FEISHU_BITABLE_TABLE_ID = SERVICE_TABLE_ID;
  });

  afterEach(() => {
    if (originalAppToken === undefined) delete process.env.FEISHU_BITABLE_APP_TOKEN;
    else process.env.FEISHU_BITABLE_APP_TOKEN = originalAppToken;
    if (originalTableId === undefined) delete process.env.FEISHU_BITABLE_TABLE_ID;
    else process.env.FEISHU_BITABLE_TABLE_ID = originalTableId;
  });

  it("passes the stored client_token to Feishu create so retries are idempotent", async () => {
    callFeishu.mockResolvedValueOnce({ record: { record_id: "rec_service_1" } });

    await expect(
      createServiceRecordHandler(ctx, {
        subject: "Need quote",
        selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny" }],
        clientToken: "client-token-1",
      }),
    ).resolves.toEqual({ recordId: "rec_service_1" });

    expect(callFeishu).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        path: `/bitable/v1/apps/${APP_TOKEN}/tables/${SERVICE_TABLE_ID}/records`,
        query: { client_token: "client-token-1" },
      }),
    );
  });
});
