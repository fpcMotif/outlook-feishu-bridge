# Fallback Feishu login via a Bun server on the ECS Host

> **Status: accepted.** Complements [ADR-0002](0002-serve-spa-from-ecs.md). Does **not** supersede the Convex **OAuth Callback** — it adds a second, independent login path.

On 2026-05-22 a Convex platform incident took down the **action runtime** of our deployment: every action — including the OAuth-callback HTTP action — returned `InternalServerError`, while queries and mutations stayed up. Feishu login broke entirely, because the callback that exchanges the auth code *is* a Convex HTTP action. This ADR adds a **fallback** login path that does not depend on Convex at all. Convex login stays primary.

## Decision

A zero-dependency **Bun server on the ECS Host** ([`server/feishu-auth/`](../../server/feishu-auth/)) serves a *second*, separately-registered redirect URI on `https://<host>`, proxied by nginx — the same `location` pattern as the Sentry tunnel. It is driven by the **Office Dialog API** (`window.open`/`postMessage` is unreliable inside the Outlook taskpane): the SPA calls `displayDialogAsync` against a same-domain `GET /feishu/oauth/start`, which 302-redirects to the Feishu authorize page; after consent Feishu redirects to `GET /feishu/oauth/callback`, which performs the Feishu **v2 OAuth** code→token exchange (`POST authen/v2/oauth/token`, `client_id`+`client_secret` in the body), fetches the user profile (`authen/v1/user_info`), loads office.js, and hands the token back via `Office.context.ui.messageParent` (the only channel a same-domain dialog page has). The SPA keeps the token in `localStorage` (**no DB**) and passes it to the forward functions as an **optional `userAccessToken` argument**; those functions resolve `arg ?? <DB read>`, so the Convex and box token paths coexist.

The box is a **manual "trouble logging in?" fallback** — Convex stays the default. Tokens are not refreshed server-side; on expiry (~2 h) the SPA re-runs the popup. Feishu permits multiple redirect URLs (Developer Console → Security Settings), so the box URI is added alongside the existing Convex one and nothing about the Convex path changes.

## Why

- **Resilience.** Login no longer shares fate with the Convex action runtime — the exact failure that motivated this.
- **In-region.** The callback runs in Mainland China (the box), so both the browser redirect and the server→Feishu calls are in-region (also chips at the CN↔US round-trip latency the project cares about).
- **Minimal surface.** `Bun.serve()` with zero dependencies, two tiny endpoints (`/start`, `/callback`), secret-in-env. A fallback's whole value is reliability, so fewer moving parts is the point.
- **No new identity store.** Browser-held token: no schema, no table, no migration.

## Consequences

- **Two token models.** The user-token-consuming Convex functions (`forwardToFeishu`, the group list, the contact search) accept an optional `userAccessToken`: present → use it (box path); absent → read from the DB (Convex path).
- **Token in `localStorage`.** An XSS exposure; acceptable for an internal add-in (the SPA already keeps a session id there). Reconsider if this app ever holds higher-value scopes.
- **The box gains a process.** A long-running Bun service under **systemd** + an nginx proxy `location`; `FEISHU_APP_SECRET` now also lives on the box (systemd `EnvironmentFile`, never in the repo). The box was already load-bearing (it serves the SPA), so this is not a new single point of failure.
- **Feishu console** must whitelist the box redirect URI; the scope set is unchanged.
- **No server-side refresh yet.** `offline_access` is still requested (refresh token stored but unused), so a `/refresh` endpoint can be added later without re-registering anything.

## Alternatives rejected

- **Cloudflare Workers** — poor Mainland-China reachability (the China Network needs an Enterprise plan + ICP); the browser redirect would land on overseas PoPs.
- **Aliyun Function Compute** — viable, but a new custom domain + ICP filing + cold starts, versus reusing the box's existing TLS+ICP'd domain and nginx.
- **Box writes the token to Convex via a mutation** — keeps the DB model, but still breaks if Convex is *fully* down (not just actions); not "no DB".
- **Make the box the primary login** — chose Convex-primary to preserve current behaviour and keep the box a pure fallback.
