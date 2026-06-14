/* eslint-disable max-lines-per-function */
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
  it("replaces &, <, >, \", and ' with their HTML entities", () => {
    expect(escapeHtml(`<a href='x' title="test">Tom & Jerry</a>`)).toBe(
      "&lt;a href=&#39;x&#39; title=&quot;test&quot;&gt;Tom &amp; Jerry&lt;/a&gt;",
    );
  });

  it("escapes ampersands first", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("escapes single quotes correctly", () => {
    expect(escapeHtml("'single'")).toBe("&#39;single&#39;");
  });
});

describe("html", () => {
  it("embeds the message inside the card markup and auto-close script", () => {
    const out = html("Hello world");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain(`<p class="msg">Hello world</p>`);
    expect(out).toContain("window.close()");
  });
});

describe("handleFeishuOAuthCallback", () => {
  it("returns 400 text/html when code is missing", async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const res = await handleFeishuOAuthCallback(new Request(`${CALLBACK}?state=sess-1`), exchange);
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(await res.text()).toContain("missing code or state parameter");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("returns 400 when state is missing", async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const res = await handleFeishuOAuthCallback(new Request(`${CALLBACK}?code=abc`), exchange);
    expect(res.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("returns 200 and passes code plus state to exchange", async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const res = await handleFeishuOAuthCallback(
      new Request(`${CALLBACK}?code=the-code&state=sess-1`),
      exchange,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Login successful");
    expect(exchange).toHaveBeenCalledWith("the-code", "sess-1");
  });

  it("returns 500 with an escaped Error message when exchange throws", async () => {
    const exchange = vi.fn(() => Promise.reject(new Error(`<script>alert("x")</script>`)));
    const res = await handleFeishuOAuthCallback(new Request(`${CALLBACK}?code=c&state=s`), exchange);
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).toContain("Login failed: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert");
  });

  it("logs the real cause server-side on failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exchange = vi.fn(() => Promise.reject(new Error("nope")));
    await handleFeishuOAuthCallback(new Request(`${CALLBACK}?code=c&state=s`), exchange);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("token exchange failed: nope"));
  });
});
