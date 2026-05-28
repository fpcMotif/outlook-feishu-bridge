/* eslint-disable max-lines-per-function */
// Tests for the Self-Forward chain — the 4-step Graph flow that delivers the
// `Note to myself` copy into the Initiator's own mailbox (ADR-0017):
//   1) OBO exchange   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//   2) createForward   POST https://graph.microsoft.com/v1.0/me/messages/{id}/createForward
//   3) PATCH draft     PATCH https://graph.microsoft.com/v1.0/me/messages/{draftId}
//   4) send draft      POST  https://graph.microsoft.com/v1.0/me/messages/{draftId}/send
// Fetch is injected so the chain is testable without the Convex action runtime.

import { describe, expect, it, vi } from "vitest";

import { runSelfForwardChain, type Fetcher } from "./selfForwardChain";

const ENV = {
  tenantId: "common",
  clientId: "00000000-0000-0000-0000-000000000aaa",
  clientSecret: "secret-value",
};
const INPUT = {
  bootstrap: "bootstrap-bearer",
  originalMessageId: "AAMkAGI0RestId",
  originalSubject: "Inquiry - bulk L-Carnitine",
  selfEmail: "jenny.xu@fenchem.com",
};

function jsonResponse(body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("runSelfForwardChain — happy path", () => {
  it("issues the four documented Graph calls in order and returns ok", async () => {
    const fetcher = vi.fn<Fetcher>((url, init) => {
      const u = url.toString();
      if (u.startsWith("https://login.microsoftonline.com/")) {
        return Promise.resolve(
          jsonResponse({
            access_token: "graph-access-token",
            token_type: "Bearer",
            expires_in: 3599,
          }),
        );
      }
      if (u.endsWith("/me/messages/AAMkAGI0RestId/createForward")) {
        return Promise.resolve(jsonResponse({ id: "DRAFT-1", conversationId: "conv-fwd-1" }));
      }
      if (u === "https://graph.microsoft.com/v1.0/me/messages/DRAFT-1" && init?.method === "PATCH") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (u.endsWith("/me/messages/DRAFT-1/send")) {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${u}`);
    });

    const result = await runSelfForwardChain(INPUT, ENV, fetcher);

    expect(result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(4);

    // Step 1 — OBO. Official body shape:
    //   https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow#middle-tier-access-token-request
    const [oboUrl, oboInit] = fetcher.mock.calls[0];
    expect(oboUrl.toString()).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    expect(oboInit?.method).toBe("POST");
    const oboBody = new URLSearchParams(String(oboInit?.body));
    expect(oboBody.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(oboBody.get("client_id")).toBe(ENV.clientId);
    expect(oboBody.get("client_secret")).toBe(ENV.clientSecret);
    expect(oboBody.get("assertion")).toBe("bootstrap-bearer");
    expect(oboBody.get("requested_token_use")).toBe("on_behalf_of");
    expect(oboBody.get("scope")).toBe("https://graph.microsoft.com/Mail.Send");

    // Step 2 — createForward. Doc: https://learn.microsoft.com/graph/api/message-createforward
    // No body required — Graph creates the draft with default forward content.
    const [cfUrl, cfInit] = fetcher.mock.calls[1];
    expect(cfUrl.toString()).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/AAMkAGI0RestId/createForward",
    );
    expect(cfInit?.method).toBe("POST");
    const cfHeaders = (cfInit?.headers ?? {}) as Record<string, string>;
    expect(cfHeaders["authorization"]).toBe("Bearer graph-access-token");

    // Step 3 — PATCH the draft with the documented `message-update` shape.
    // Doc: https://learn.microsoft.com/graph/api/message-update
    const [patchUrl, patchInit] = fetcher.mock.calls[2];
    expect(patchUrl.toString()).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/DRAFT-1",
    );
    expect(patchInit?.method).toBe("PATCH");
    expect(JSON.parse(String(patchInit?.body))).toEqual({
      subject: "Note to myself — Inquiry - bulk L-Carnitine",
      toRecipients: [{ emailAddress: { address: "jenny.xu@fenchem.com" } }],
    });

    // Step 4 — send. Doc: https://learn.microsoft.com/graph/api/message-send
    const [sendUrl, sendInit] = fetcher.mock.calls[3];
    expect(sendUrl.toString()).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/DRAFT-1/send",
    );
    expect(sendInit?.method).toBe("POST");
  });
});

describe("runSelfForwardChain — failure modes", () => {
  // ADR-0017 soft-fail: every non-2xx surfaces as `ok: false` carrying the step
  // and AAD/Graph error code. The Bitable row is unchanged; the UI shows the
  // retry chip.
  it("returns ok:false with step=obo when the OBO exchange fails", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_grant", error_description: "AADSTS50058: …" },
          { status: 400 },
        ),
      ),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("obo");
      expect(result.code).toBe("invalid_grant");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false with step=createForward when Graph rejects the draft create", async () => {
    let n = 0;
    const fetcher = vi.fn<Fetcher>(() => {
      n += 1;
      if (n === 1) {
        return Promise.resolve(
          jsonResponse({ access_token: "g", token_type: "Bearer", expires_in: 3599 }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          { error: { code: "ErrorAccessDenied", message: "Mail.Send not consented" } },
          { status: 403 },
        ),
      );
    });
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("createForward");
      expect(result.code).toBe("ErrorAccessDenied");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
