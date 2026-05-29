/* eslint-disable max-lines-per-function */
// Tests for the app-only native Self-Forward chain:
//   1) client_credentials token
//   2) POST /users/{selfEmail}/messages/{originalMessageId}/forward

import { describe, expect, it, vi } from "vitest";

import { runSelfForwardChain, type Fetcher } from "./selfForwardChain";

const ENV = {
  tenantId: "93b47f6a-5661-4677-a047-ab4fee1cad47",
  clientId: "2ccb5d91-1bd7-4b62-9c3b-71d115c8af0a",
  clientSecret: "secret-value",
};
const INPUT = {
  originalMessageId: "AAMkADAwATM0MDAAMS1hYzNiLWY1MjAtMDACLTAwCgBGAAAA",
  selfEmail: "fanpc@fenchem.com",
};

function jsonResponse(body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("runSelfForwardChain app-only native forward happy path", () => {
  it("gets an app token and asks Graph to forward the current Mail Item to self", async () => {
    const forwardUrl =
      "https://graph.microsoft.com/v1.0/users/fanpc%40fenchem.com/messages/AAMkADAwATM0MDAAMS1hYzNiLWY1MjAtMDACLTAwCgBGAAAA/forward";
    const fetcher = vi.fn<Fetcher>((url, init) => {
      const u = url.toString();
      if (u.startsWith("https://login.microsoftonline.com/")) {
        return Promise.resolve(
          jsonResponse({
            access_token: "graph-app-token",
            token_type: "Bearer",
            expires_in: 3599,
          }),
        );
      }
      if (u === forwardUrl) {
        return Promise.resolve(
          new Response(null, {
            status: 202,
            headers: { "request-id": "req-123" },
          }),
        );
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${u}`);
    });

    const result = await runSelfForwardChain(INPUT, ENV, fetcher);

    expect(result).toEqual({ ok: true, requestId: "req-123" });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetcher.mock.calls[0];
    expect(tokenUrl.toString()).toBe(
      "https://login.microsoftonline.com/93b47f6a-5661-4677-a047-ab4fee1cad47/oauth2/v2.0/token",
    );
    expect(tokenInit?.method).toBe("POST");
    const tokenBody = new URLSearchParams(String(tokenInit?.body));
    expect(tokenBody.get("grant_type")).toBe("client_credentials");
    expect(tokenBody.get("client_id")).toBe(ENV.clientId);
    expect(tokenBody.get("client_secret")).toBe(ENV.clientSecret);
    expect(tokenBody.get("scope")).toBe("https://graph.microsoft.com/.default");

    const [mailUrl, mailInit] = fetcher.mock.calls[1];
    expect(mailUrl.toString()).toBe(forwardUrl);
    expect(mailInit?.method).toBe("POST");
    const mailHeaders = (mailInit?.headers ?? {}) as Record<string, string>;
    expect(mailHeaders.authorization).toBe("Bearer graph-app-token");
    const sent = JSON.parse(String(mailInit?.body));
    expect(sent.toRecipients).toEqual([
      { emailAddress: { address: "fanpc@fenchem.com" } },
    ]);
    // No customer / requests passed; deeper preamble shape is unit-tested in
    // selfForwardMessage.test.ts.
    expect(sent.comment).toBe(
      ["Synced to Feishu Bitable", "------------------"].join("\n"),
    );
  });

  it("URL-encodes Graph ids that still contain path delimiters", async () => {
    const fetcher = vi.fn<Fetcher>((url) => {
      const u = url.toString();
      if (u.startsWith("https://login.microsoftonline.com/")) {
        return Promise.resolve(jsonResponse({ access_token: "g" }));
      }
      expect(u).toContain("/messages/a%2Fb%3Dc/forward");
      return Promise.resolve(new Response(null, { status: 202 }));
    });

    const result = await runSelfForwardChain(
      { ...INPUT, originalMessageId: "a/b=c" },
      ENV,
      fetcher,
    );

    expect(result).toEqual({ ok: true, requestId: undefined });
  });
});

describe("runSelfForwardChain app-only failure modes", () => {
  it("returns ok:false with step=token when the tenant/app secret is wrong", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_client", error_description: "AADSTS7000215: Invalid secret" },
          { status: 401 },
        ),
      ),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("token");
      expect(result.code).toBe("invalid_client");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false with step=forward when Graph rejects the native forward", async () => {
    let n = 0;
    const fetcher = vi.fn<Fetcher>(() => {
      n += 1;
      if (n === 1) {
        return Promise.resolve(jsonResponse({ access_token: "g" }));
      }
      return Promise.resolve(
        jsonResponse(
          { error: { code: "ErrorItemNotFound", message: "Message id not found" } },
          { status: 404 },
        ),
      );
    });
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("forward");
      expect(result.code).toBe("ErrorItemNotFound");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
