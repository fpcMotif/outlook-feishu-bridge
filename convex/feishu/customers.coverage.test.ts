// Coverage companion to customers.test.ts. The base file pins the happy-path
// projection + auto-match; this file drives the remaining branches:
//   - flattenText / firstOwner field-shape edge cases (rich-text/User/absent)
//   - emailDomain (now the single source of truth shared with bitable.ts),
//     including the trailing-`@` and whitespace-only-domain guards
//   - findCustomerByEmail's non-string-domain skip + malformed-domain branches
//   - the listCustomers preload paging loop (has_more recursion, MAX_RECORDS
//     and 20-page caps) and searchCustomers' empty-query short-circuit + filter
//     shape — exercised through the registered action handlers with `./call`
//     mocked, so the dummy ctx is never actually used for I/O.
//
// Official field shapes verified against the Bitable record-data-structure doc:
//   https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallFeishuOptions } from "./call";

// Mock the transport so the action handlers resolve without a live Convex ctx
// or network. The handlers pass `ctx` straight through to callFeishu, so a
// dummy ctx ({}) is sufficient once callFeishu is replaced.
const callFeishu = vi.fn();
vi.mock("./call", () => ({
  callFeishu: (...args: unknown[]) => callFeishu(...args),
}));

import {
  emailDomain,
  findCustomerByEmail,
  listCustomers,
  mapFeishuItemToCustomer,
  searchCustomers,
  type CustomerRecord,
} from "./customers";

// The registered action exposes its body as `_handler` in this build of Convex
// (verified by probe). With callFeishu mocked, calling it with a dummy ctx
// exercises the real handler logic — including requireAppToken and the
// fetchCustomerPage paging loop — without any I/O.
type Handler<A, R> = { _handler: (ctx: unknown, args: A) => Promise<R> };
const runList = (listCustomers as unknown as Handler<Record<string, never>, { records: CustomerRecord[]; generatedAt: number }>)["_handler"];
const runSearch = (searchCustomers as unknown as Handler<{ query: string }, { records: CustomerRecord[] }>)["_handler"];

const DUMMY_CTX = {};

beforeEach(() => {
  callFeishu.mockReset();
  process.env.FEISHU_BITABLE_APP_TOKEN = "app_tok_test";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapFeishuItemToCustomer — field-shape branches", () => {
  // flattenText joins a multi-segment rich-text array (Feishu splits long text
  // and @-mentions into multiple {text,type} segments).
  it("joins a multi-segment rich-text array into one string", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "r1",
      fields: { "Account Name": [{ text: "A" }, { text: "B" }] },
    });
    expect(c.name).toBe("AB");
  });

  // A segment whose .text is null/missing contributes '' (String(... ?? '')),
  // so the surrounding real text survives (customers.ts:79).
  it("treats a null-text segment as '' and keeps the rest", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "r2",
      fields: { "Account Name": [{ text: null }, { text: "x" }] },
    });
    expect(c.name).toBe("x");
  });

  // A primitive (non-object) segment hits the false branch of the `"text" in
  // seg` guard and contributes '' rather than throwing (customers.ts:78-81).
  it("treats a primitive segment as '' rather than throwing", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "r3",
      fields: { "Account Name": [42, { text: "y" }] },
    });
    expect(c.name).toBe("y");
  });

  // An array of only empty-text segments joins to '' → flattenText returns
  // undefined, and name falls back to '' via the ?? "" at customers.ts:62.
  it("maps an all-empty-text rich-text array to name='' (joined==='' → undefined)", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "r4",
      fields: { "Account Name": [{ text: "" }], "域名": [{ text: "" }] },
    });
    expect(c.name).toBe("");
    expect(c.domain).toBeUndefined();
  });

  // A Text field arriving as a bare string (not the rich-text array) is not an
  // array → flattenText early-returns undefined (customers.ts:75).
  it("maps a non-array Text value (bare string) to undefined", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "r5",
      fields: { "Account Name": [{ text: "Acme" }], "域名": "acme.example", "全名": ["x"], "Account No.": [] },
    });
    expect(c.domain).toBeUndefined();
    // "全名" array whose first segment is the primitive "x" flattens to ''→undefined
    expect(c.fullName).toBeUndefined();
    // empty array → undefined
    expect(c.accountNo).toBeUndefined();
  });

  // Country and Regio is a SingleSelect (plain string). A non-string value
  // (null / array) hits the false branch of the typeof ternary at
  // customers.ts:66 → countryRegion undefined.
  it("passes a string Country and Regio (SingleSelect) through unchanged", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "r6b",
      fields: { "Account Name": [{ text: "Acme" }], "Country and Regio": "Germany 德国" },
    });
    expect(c.countryRegion).toBe("Germany 德国");
  });

  it("maps a non-string Country and Regio to undefined", () => {
    const asNull = mapFeishuItemToCustomer({
      record_id: "r6",
      fields: { "Account Name": [{ text: "Acme" }], "Country and Regio": null },
    });
    const asArray = mapFeishuItemToCustomer({
      record_id: "r7",
      fields: { "Account Name": [{ text: "Acme" }], "Country and Regio": ["Germany"] },
    });
    expect(asNull.countryRegion).toBeUndefined();
    expect(asArray.countryRegion).toBeUndefined();
  });
});

describe("firstOwner (via mapFeishuItemToCustomer)", () => {
  // Owner is a User array of {id,name,...}. A first entry that is not an object
  // (e.g. a bare open_id string) → owner null (customers.ts:89).
  it("yields owner=null when the first Owner entry is not an object", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "o1",
      fields: { "Account Name": [{ text: "Acme" }], Owner: ["ou_x"] },
    });
    expect(c.owner).toBeNull();
  });

  // First entry is an object but its id is not a string → owner null
  // (customers.ts:91).
  it("yields owner=null when the first Owner entry has a non-string id", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "o2",
      fields: { "Account Name": [{ text: "Acme" }], Owner: [{ id: 123, name: "X" }] },
    });
    expect(c.owner).toBeNull();
  });

  // Valid id but missing/non-string name → name falls back to '' (the ternary
  // at customers.ts:92).
  it("yields {openId, name:''} when the Owner has a valid id but no string name", () => {
    const c = mapFeishuItemToCustomer({
      record_id: "o3",
      fields: { "Account Name": [{ text: "Acme" }], Owner: [{ id: "ou_a" }] },
    });
    expect(c.owner).toEqual({ openId: "ou_a", name: "" });
  });
});

describe("emailDomain", () => {
  it("returns the lowercased trimmed domain after the last '@'", () => {
    expect(emailDomain("A.B@Mail.Fenchem.COM ")).toBe("mail.fenchem.com");
  });

  it("returns null when there is no '@' (at < 0)", () => {
    expect(emailDomain("not-an-email")).toBeNull();
  });

  // Trailing '@' with nothing after it: at === length-1 guard (customers.ts:119).
  it("returns null for a trailing '@' (e.g. 'user@')", () => {
    expect(emailDomain("user@")).toBeNull();
  });

  // Domain that is only whitespace trims to '' → the `domain || null` branch
  // at customers.ts:121 returns null.
  it("returns null when the domain part is only whitespace", () => {
    expect(emailDomain("a@   ")).toBeNull();
  });

  it("takes the part after the LAST '@' when multiple are present", () => {
    expect(emailDomain("weird@local@example.com")).toBe("example.com");
  });
});

describe("findCustomerByEmail — guards", () => {
  const directory: CustomerRecord[] = [
    { recordId: "r1", name: "Bayer", domain: "bayer.de", owner: null },
    // a directory entry whose domain is the wrong type (non-string) must be
    // skipped by the typeof guard at customers.ts:108, not throw.
    { recordId: "r2", name: "Weird", domain: 42 as unknown as string, owner: null },
  ];

  it("returns null for an email with a trailing '@'", () => {
    expect(findCustomerByEmail(directory, "a@")).toBeNull();
  });

  it("returns null for an email whose domain is only whitespace", () => {
    expect(findCustomerByEmail(directory, "a@   ")).toBeNull();
  });

  it("skips directory entries whose domain is not a string without matching", () => {
    // "42" can never equal a real domain; the non-string-domain row must be
    // filtered by the typeof guard rather than coerced.
    expect(findCustomerByEmail(directory, "x@42")).toBeNull();
  });

  it("still matches a valid string-domain entry alongside a non-string one", () => {
    expect(findCustomerByEmail(directory, "m@bayer.de")?.recordId).toBe("r1");
  });
});

// requireAppToken + fetchCustomerPage + the listCustomers handler are reached
// through the registered action. callFeishu is mocked, so the dummy ctx is
// never used for I/O.
describe("listCustomers handler (preload paging)", () => {
  const item = (id: string, name: string) => ({
    record_id: id,
    fields: { "Account Name": [{ text: name }] },
  });

  it("throws when FEISHU_BITABLE_APP_TOKEN is unset", async () => {
    delete process.env.FEISHU_BITABLE_APP_TOKEN;
    await expect(runList(DUMMY_CTX, {})).rejects.toThrow("FEISHU_BITABLE_APP_TOKEN must be set");
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("returns the mapped projection for a single non-paged page (has_more=false)", async () => {
    callFeishu.mockResolvedValueOnce({ items: [item("a", "Acme"), item("b", "Bayer")], has_more: false });
    const out = await runList(DUMMY_CTX, {});
    expect(out.records.map((r) => r.name)).toEqual(["Acme", "Bayer"]);
    expect(typeof out.generatedAt).toBe("number");
    expect(callFeishu).toHaveBeenCalledTimes(1);
  });

  it("does not request page_token on the first call but sends it on the recursion", async () => {
    callFeishu
      .mockResolvedValueOnce({ items: [item("a", "P1")], has_more: true, page_token: "tok2" })
      .mockResolvedValueOnce({ items: [item("b", "P2")], has_more: false });
    const out = await runList(DUMMY_CTX, {});
    expect(out.records.map((r) => r.name)).toEqual(["P1", "P2"]);
    expect(callFeishu).toHaveBeenCalledTimes(2);
    const firstQuery = (callFeishu.mock.calls[0][1] as CallFeishuOptions).query!;
    const secondQuery = (callFeishu.mock.calls[1][1] as CallFeishuOptions).query!;
    expect(firstQuery.page_size).toBe("500");
    expect(firstQuery.page_token).toBeUndefined();
    expect(secondQuery.page_token).toBe("tok2");
  });

  it("stops recursing when has_more=true but page_token is absent", async () => {
    callFeishu.mockResolvedValueOnce({ items: [item("a", "Only")], has_more: true });
    const out = await runList(DUMMY_CTX, {});
    expect(out.records.map((r) => r.name)).toEqual(["Only"]);
    expect(callFeishu).toHaveBeenCalledTimes(1);
  });

  it("treats a page that omits items as empty (data.items ?? [] fallback at customers.ts:160)", async () => {
    callFeishu.mockResolvedValueOnce({ has_more: false });
    const out = await runList(DUMMY_CTX, {});
    expect(out.records).toEqual([]);
  });

  it("stops at the MAX_RECORDS (6000) cap, slicing the accumulator and not paging further", async () => {
    // Page 1 returns 6000 rows with has_more=true; the slice + >=MAX_RECORDS
    // guard must halt before a second request.
    const big = Array.from({ length: 6000 }, (_v, i) => item(`r${i}`, `N${i}`));
    callFeishu.mockResolvedValueOnce({ items: big, has_more: true, page_token: "tokX" });
    const out = await runList(DUMMY_CTX, {});
    expect(out.records).toHaveLength(6000);
    expect(callFeishu).toHaveBeenCalledTimes(1);
  });

  it("stops after 20 pages even when has_more stays true (pageCount cap)", async () => {
    // Every page returns one row and claims more; the pageCount>=20 guard caps
    // the recursion at 20 calls. The cap is checked at the TOP of the next
    // fetchCustomerPage, so page 0..19 fire (20 calls) then the 21st is gated.
    callFeishu.mockResolvedValue({ items: [item("p", "P")], has_more: true, page_token: "t" });
    const out = await runList(DUMMY_CTX, {});
    expect(callFeishu).toHaveBeenCalledTimes(20);
    expect(out.records).toHaveLength(20);
  });
});

describe("searchCustomers handler", () => {
  it("short-circuits to {records:[]} without calling Feishu for a blank/whitespace query", async () => {
    expect(await runSearch(DUMMY_CTX, { query: "" })).toEqual({ records: [] });
    expect(await runSearch(DUMMY_CTX, { query: "   " })).toEqual({ records: [] });
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("sends the or/contains filter on Account Name + 域名 and maps the items", async () => {
    callFeishu.mockResolvedValueOnce({
      items: [{ record_id: "s1", fields: { "Account Name": [{ text: "Searched" }] } }],
    });
    const out = await runSearch(DUMMY_CTX, { query: "  Acme  " });
    expect(out.records.map((r) => r.name)).toEqual(["Searched"]);
    const opts = callFeishu.mock.calls[0][1] as CallFeishuOptions;
    expect(opts.auth).toBe("tenant");
    expect(opts.method).toBe("POST");
    const filter = (opts.json as { filter: { conjunction: string; conditions: Array<{ field_name: string; operator: string; value: string[] }> } }).filter;
    expect(filter.conjunction).toBe("or");
    expect(filter.conditions).toEqual([
      { field_name: "Account Name", operator: "contains", value: ["Acme"] },
      { field_name: "域名", operator: "contains", value: ["Acme"] },
    ]);
  });

  it("returns [] when the search response has no items (data.items undefined)", async () => {
    callFeishu.mockResolvedValueOnce({});
    expect(await runSearch(DUMMY_CTX, { query: "x" })).toEqual({ records: [] });
  });

  it("throws when FEISHU_BITABLE_APP_TOKEN is unset for a non-empty query", async () => {
    delete process.env.FEISHU_BITABLE_APP_TOKEN;
    await expect(runSearch(DUMMY_CTX, { query: "Acme" })).rejects.toThrow(
      "FEISHU_BITABLE_APP_TOKEN must be set",
    );
  });
});
