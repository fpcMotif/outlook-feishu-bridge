# Outlook → Feishu Bridge

An Outlook add-in that lets users forward Outlook mail (and attachments) into Feishu — via bot webhook, group chat, or Bitable — and create Feishu Docs from email content. Frontend is a Vite SPA loaded into the Outlook taskpane; backend logic and data live in Convex.

## Language

**SPA**:
The React + Vite static bundle loaded inside the Outlook taskpane iframe. The same source ships to two hosts: the **ECS Host** (built with base path `/addin/`, served at `https://<host>/addin/`) for the CN audience, and the **Global Host** (built with base `/`, served at `https://outlook-feishu-addin.pages.dev/`) for everyone else ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)).
_Avoid_: "frontend" (overloaded), "client", "the addin" (manifest + SPA are different things).

**Outlook Manifest**:
The `OfficeApp` XML at [public/manifest.xml](public/manifest.xml) that Outlook reads to discover the add-in's display name, icons, command surfaces, and taskpane URL. Its `SourceLocation` / `Taskpane.Url` point at the host that serves the **SPA**. It ships with two placeholders — `__ADDIN_DOMAIN__` (the host) and `__ADDIN_BASE__` (the path prefix) — which **must be substituted before sideloading** via `scripts/manifest.sh <domain> [base]`; the raw token makes Outlook fail with "server IP address could not be found". There are two generated manifests, one per host: the **ECS Host** (`<host>` + `addin/`) for CN users, the **Global Host** (`outlook-feishu-addin.pages.dev` + empty base) for everyone else. Changing a URL forces a manifest regen and re-sideload.
_Avoid_: "the addin config", "the XML".

**ECS Host**:
A single Aliyun ECS Ubuntu 24 instance (`__ADDIN_DOMAIN__`) running nginx. Its primary, steady-state job is serving the **SPA** as static files from `/var/www/addin` under location `/addin/`. It serves the **Mainland-China audience**; the **Global Host** (Cloudflare Pages) serves everyone else from the same codebase ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)) — so it no longer *replaces* Cloudflare (as ADR-0002 framed it), it runs alongside it. It also runs the **Fallback OAuth Callback** — a small Bun auth server behind nginx ([ADR-0008](docs/adr/0008-fallback-login-via-box.md)). It may *also* be used later as a reverse-proxy fallback to the **Convex Backend** if Mainland-China ↔ US connectivity degrades — that proxy is not built yet.
_Avoid_: "CDN" (there is no CDN in front of it today), "gateway" (it's a web server, not just a proxy), "the backend" (the backend is Convex).

**Global Host**:
The Cloudflare Pages deployment (`outlook-feishu-addin.pages.dev`, base `/`) that serves the **SPA** to the **non-Mainland-China audience**, complementing the **ECS Host** from one codebase ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)). Static-only: it uses the primary **OAuth Callback** (host-independent, on `*.convex.site`) but has **no Fallback OAuth Callback** (no Bun server runs on Pages), and its Sentry ingest is direct (no `/_sentry/` tunnel). CSP + SPA fallback come from `public/_headers` + `public/_redirects`, the Cloudflare equivalents of the ECS nginx config.
_Avoid_: "Edge Host" (ADR-0001's superseded "CN Edge Gateway" already attached "edge" to the **ECS Host**), "the CDN", "the pages.dev".

**Atomic Release**:
The deploy mechanism on the **ECS Host**. `scripts/deploy.sh` unpacks each build into `/var/www/releases/<timestamp>/`, flips the `/var/www/addin` symlink to it, and prunes all but the newest 3 releases. Rollback = repoint the symlink at an older release dir.
_Avoid_: "the deploy folder".

**Convex Backend**:
The hosted Convex deployment (`diligent-parakeet-460.convex.{cloud,site}`). Owns the schema, mutations, queries, scheduled jobs, and one HTTP route. Stays US-hosted; not migrating to Aliyun in this iteration.

**OAuth Callback**:
The **primary** path that exchanges a Feishu authorization code for a user token: the HTTP route `GET /feishu/oauth/callback` on `*.convex.site` ([convex/http.ts:7](convex/http.ts:7)). Its URI is registered in the Feishu open-platform console and points directly at Convex. Because it is a Convex **HTTP action**, it shares fate with the Convex action runtime — when that is unavailable, login falls back to the **Fallback OAuth Callback** on the **ECS Host** ([ADR-0008](docs/adr/0008-fallback-login-via-box.md)).
_Avoid_: "the Feishu redirect".

**Fallback OAuth Callback**:
A second, separately-registered redirect URI `GET /feishu/oauth/callback` on the **ECS Host** (`https://<host>/…`), served by a zero-dependency **Bun** server ([server/feishu-auth/](server/feishu-auth/)) behind nginx — the same proxy pattern as the Sentry tunnel. It does the Feishu **v2** code→token exchange and returns the token to the **SPA** via the **Office Dialog API** (`messageParent`) — `window.open`/`postMessage` is unreliable in the Outlook taskpane, so the SPA opens it with `displayDialogAsync`. The SPA then holds the token in `localStorage` (no DB) and passes it to the **Forward pipeline** as an optional `userAccessToken`. A manual "trouble logging in?" path, used only when the **Convex Backend**'s action runtime is down. See [ADR-0008](docs/adr/0008-fallback-login-via-box.md).
_Avoid_: conflating it with the primary Convex **OAuth Callback** — two registered redirect URIs with different token models (DB vs browser-held).

**Feishu Open Platform**:
`open.feishu.cn`. Both an outbound API target (called from Convex actions in `convex/feishu/*.ts`) and the OAuth identity provider (issues the redirect to **OAuth Callback**). Outbound calls go directly from Convex.

**Forward pipeline**:
The click→Feishu path that [`src/forward/forwardEmail.ts`](src/forward/forwardEmail.ts) orchestrates: generate the email **PDF**, upload each **attachment**, optionally build a **Feishu Doc**, send the card + follow-up messages to each target, then tag the Outlook item. Attachments, inline images, and large Doc media reach Convex via **File Storage** `storageId`, never as a function argument; the small text PDF is the measured exception — it rides inline as a `pdfBytes` arg, since staging it cost ~3s of needless latency ([ADR-0004](docs/adr/0004-binaries-cross-via-convex-file-storage.md)). The PDF is a text-only vector document (jsPDF selectable text), not a raster snapshot ([ADR-0005](docs/adr/0005-email-pdf-is-text-only-vector.md)). Independent work runs concurrently to cut latency; only the per-receiver "card lands first" ordering is preserved ([ADR-0006](docs/adr/0006-forward-latency-parallelization.md)).
_Avoid_: "the upload" (PDF, attachment, and Doc media are three distinct upload paths), "send the email" (we forward a *copy* into Feishu; the Outlook mail is untouched besides the category tag).

**User-identity call**:
A Feishu API call made with the signed-in person's user access token — used to forward mail *as them*, list *their* groups (`/im/v1/chats`), and search the directory (`/search/v1/user`); contrast a **tenant-identity call** made with the app/bot token (bot-webhook posts, Docs, Bitable).
_Avoid_: "the Feishu token" — there are two, user vs tenant.

**Email PDF**:
The **text-only**, selectable vector PDF of a forwarded email's words (images are excluded — they go separately as Feishu attachments, so the PDF stays small and nothing is sent twice), rendered with **jsPDF** (wrapped selectable text under a bold subject; body via Office `Text` coercion). It is **not** a screenshot. See [ADR-0005](docs/adr/0005-email-pdf-is-text-only-vector.md).
_Avoid_: "email screenshot" / "rendered email image" — it carries no images and is real selectable text.

## Relationships

- The **Outlook Manifest** points `SourceLocation` at whichever host serves the SPA (`https://<ECS Host>/addin/` for CN users, the **Global Host** root for everyone else).
- The **ECS Host** serves the **SPA** static bundle at `/addin/`.
- The **Global Host** (Cloudflare Pages) serves the same **SPA** at root `/` to non-CN users, using the primary **OAuth Callback** only — it has no **Fallback OAuth Callback** ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)).
- The **SPA** calls the **Convex Backend** directly (WebSocket for queries/mutations on `*.convex.cloud`, HTTP for actions on `*.convex.site`).
- The **ECS Host** *may later* reverse-proxy to the **Convex Backend** as a CN-resident fallback — not built today.
- The **Convex Backend** handles the primary **OAuth Callback** directly, with no ECS involvement.
- The **ECS Host** serves the **Fallback OAuth Callback** (a Bun auth server) when the **Convex Backend**'s action runtime is down ([ADR-0008](docs/adr/0008-fallback-login-via-box.md)).
- The **Convex Backend** makes outbound calls to the **Feishu Open Platform** directly.

## Example dialogue

> **New engineer:** "Where does the SPA actually get served from?"
> **Domain expert:** "Two hosts, one codebase. CN users hit the **ECS Host** — an Aliyun Ubuntu box running nginx; the SPA is built with base `/addin/`, lives at `/var/www/addin` (a symlink to the latest **Atomic Release**), and Outlook's manifest loads `https://<host>/addin/`. Everyone else hits the **Global Host** — Cloudflare Pages at `outlook-feishu-addin.pages.dev`, built at root `/`. Same **Convex Backend** behind both ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md))."
> **New engineer:** "And the backend — does it run on that box too?"
> **Domain expert:** "No. Data and logic stay in the **Convex Backend**, which is US-hosted. The SPA talks to Convex directly. The ECS box is just the web server today. If CN↔US connectivity ever gets bad, we can stand up a Convex reverse-proxy on the same box — but that's a future move, not how it works now."
> **New engineer:** "How do I roll back a bad deploy?"
> **Domain expert:** "Repoint the `/var/www/addin` symlink at the previous release dir under `/var/www/releases/`. We keep the last three."

## Flagged ambiguities

- "Gateway" — earlier designs called the ECS box a "CN Edge Gateway" / warm-standby proxy (see superseded ADR-0001). It is now primarily a **web server** serving the SPA. Say **ECS Host**, not "gateway".
- "Convex" sometimes refers to the SaaS company, sometimes to our specific deployment. We say **Convex Backend** when we mean ours.
- The SPA base path is **host-specific**: `/addin/` on the **ECS Host**, `/` on the **Global Host** ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)). A mismatch — an ECS manifest pointing at root, or a `/addin/` build deployed to the Global Host's root — 404s on assets.
- `/search/v1/user` reads as legacy but is **current** — it's the official Search Users API (GET, keyword in the `query` URL param, scope `contact:user:search`); there is no `contact/v3` search. The earlier Feishu `99991679` was a malformed call (POSTed body) + a missing user scope, not a dead endpoint. See [ADR-0003](docs/adr/0003-feishu-user-scopes-and-search-v1.md).
- **User-identity call** scopes (`im:chat:readonly`, `contact:user:search`, `im:message`, `offline_access`) must be listed in the authorize-URL `scope` param, or the user token can't make those calls (Feishu `99991679`). Changing the set forces every user to log out and re-authorize.
- The **Email PDF** intentionally contains **no images** — they're forwarded as Feishu attachments instead (avoids duplication + bloat). A reader expecting a visual replica of the email will be surprised; it's text-only by design. See [ADR-0005](docs/adr/0005-email-pdf-is-text-only-vector.md).
