import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireM365Env } from "./selfForward";

const FENCHEM_TENANT_ID = "93b47f6a-5661-4677-a047-ab4fee1cad47";
const KEYS = ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("requireM365Env", () => {
  it("falls back to the Fenchem tenant id when M365_TENANT_ID is unset", () => {
    process.env.M365_CLIENT_ID = "client-abc";
    process.env.M365_CLIENT_SECRET = "secret-xyz";
    expect(requireM365Env()).toEqual({
      tenantId: FENCHEM_TENANT_ID,
      clientId: "client-abc",
      clientSecret: "secret-xyz",
    });
  });

  it("uses the provided tenant id when set", () => {
    process.env.M365_TENANT_ID = "tenant-override";
    process.env.M365_CLIENT_ID = "client-abc";
    process.env.M365_CLIENT_SECRET = "secret-xyz";
    expect(requireM365Env().tenantId).toBe("tenant-override");
  });

  it("throws when either credential is missing", () => {
    process.env.M365_CLIENT_SECRET = "secret-xyz";
    expect(() => requireM365Env()).toThrow("M365_CLIENT_ID and M365_CLIENT_SECRET must be set");

    delete process.env.M365_CLIENT_SECRET;
    process.env.M365_CLIENT_ID = "client-abc";
    expect(() => requireM365Env()).toThrow("M365_CLIENT_ID and M365_CLIENT_SECRET must be set");
  });
});
