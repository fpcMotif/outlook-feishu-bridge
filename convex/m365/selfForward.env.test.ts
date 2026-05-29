// Tests for the M365 env guard in selfForward.ts. The Convex action/internalAction
// wrappers (sendSelfForwardNote, diagAadClientCredentials) need a live Convex ctx
// and are exercised by integration/e2e; here we drive the only branching logic the
// file owns — requireM365Env's FENCHEM_TENANT_ID fallback and the missing-credential
// throw — by toggling process.env (restored in afterEach).
//
// Env-var convention mirrors the Feishu secrets pattern (ADR-0017).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireM365Env } from "./selfForward";

const FENCHEM_TENANT_ID = "93b47f6a-5661-4677-a047-ab4fee1cad47";

const KEYS = ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("requireM365Env", () => {
  it("falls back to the hard-coded FENCHEM_TENANT_ID when M365_TENANT_ID is unset", () => {
    process.env.M365_CLIENT_ID = "client-abc";
    process.env.M365_CLIENT_SECRET = "secret-xyz";
    expect(requireM365Env()).toEqual({
      tenantId: FENCHEM_TENANT_ID,
      clientId: "client-abc",
      clientSecret: "secret-xyz",
    });
  });

  it("uses the provided M365_TENANT_ID over the hard-coded fallback when set", () => {
    process.env.M365_TENANT_ID = "tenant-override";
    process.env.M365_CLIENT_ID = "client-abc";
    process.env.M365_CLIENT_SECRET = "secret-xyz";
    expect(requireM365Env().tenantId).toBe("tenant-override");
  });

  it("throws when M365_CLIENT_ID is missing (clientSecret present)", () => {
    process.env.M365_CLIENT_SECRET = "secret-xyz";
    expect(() => requireM365Env()).toThrow(
      "M365_CLIENT_ID and M365_CLIENT_SECRET must be set",
    );
  });

  it("throws when M365_CLIENT_SECRET is missing even if clientId present", () => {
    process.env.M365_CLIENT_ID = "client-abc";
    expect(() => requireM365Env()).toThrow(
      "M365_CLIENT_ID and M365_CLIENT_SECRET must be set",
    );
  });

  it("throws when both credentials are missing", () => {
    expect(() => requireM365Env()).toThrow(
      "M365_CLIENT_ID and M365_CLIENT_SECRET must be set",
    );
  });

  it("returns the full {tenantId, clientId, clientSecret} triple when all present", () => {
    process.env.M365_TENANT_ID = "t-1";
    process.env.M365_CLIENT_ID = "c-1";
    process.env.M365_CLIENT_SECRET = "s-1";
    expect(requireM365Env()).toEqual({
      tenantId: "t-1",
      clientId: "c-1",
      clientSecret: "s-1",
    });
  });
});
