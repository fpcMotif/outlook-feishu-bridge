/* eslint-disable max-lines-per-function */
// Tests for the pure pieces of the Feishu OAuth callback route in http.ts.
// The httpRouter wiring + httpAction binding need a live Convex host; the
// branching logic (query parse, 400 missing-param, 200 success, 500 error with
// Error vs non-Error coercion) lives in the extracted pure handleFeishuOAuthCallback,
// and the rendering helpers escapeHtml/html are pure string builders.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { escapeHtml, handleFeishuOAuthCallback, html } from "./http";

const CALLBACK = "https://convex.example/feishu/oauth/callback";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("escapeHtml", () => {
  it("replaces &, <, >, and \" with their HTML entities in one pass", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;",
    );
  });

  it("escapes & first so an already-entity-like string is double-encoded predictably", () => {
    // &amp; -> the leading & becomes &amp;, leaving &amp;amp; — proves ordering.
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves a string with no special characters unchanged", () => {
    expect(escapeHtml("Login successful")).toBe("Login successful");
  });
});

describe("html", () => {
  it("embeds the message inside the card markup and the auto-close script", () => {
    const out = html("Hello world");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain(`<p class="msg">Hello world</p>`);
    expect(out).toContain("window.close()");
    expect(out).toContain("setTimeout");
  });
});

describe("handleFeishuOAuthCallback", () => {
  it("returns 400 text/html when the code param is missing", async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?state=sess-1`),
      exchange,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(await res.text()).toContain("missing code or state parameter");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("returns 400 when the state param is missing", async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=abc`),
      exchange,
    );
    expect(res.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("returns 200 'Login successful' and passes code + state(sessionId) to exchange", async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=the-code&state=sess-1`),
      exchange,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(await res.text()).toContain("Login successful");
    expect(exchange).toHaveBeenCalledWith("the-code", "sess-1");
  });

  it("returns 500 with the Error message when exchange throws an Error", async () => {
    const exchange = vi.fn(() => Promise.reject(new Error("token exchange boom")));
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=c&state=s`),
      exchange,
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Login failed: token exchange boom");
  });

  it("returns 500 with String(err) when exchange throws a non-Error value", async () => {
    // A thrown string hits the `String(err)` branch of the message coercion.
    const exchange = vi.fn(() => Promise.reject("plain string failure"));
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=c&state=s`),
      exchange,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Login failed: plain string failure");
  });

  it("HTML-escapes metacharacters from the thrown error message in the 500 body", async () => {
    const exchange = vi.fn(() =>
      Promise.reject(new Error(`<script>alert("x")</script>`)),
    );
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=c&state=s`),
      exchange,
    );
    const body = await res.text();
    expect(body).toContain(
      "Login failed: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    // The raw unescaped tag must NOT survive into the response.
    expect(body).not.toContain("<script>alert");
  });

  it("logs the real cause server-side on failure (observability)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exchange = vi.fn(() => Promise.reject(new Error("nope")));
    await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=c&state=s`),
      exchange,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("token exchange failed: nope"),
    );
  });
});
