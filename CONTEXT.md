# Outlook → Feishu Bridge

An Outlook add-in for **sales-request intake**: it turns a client's inbound email into one structured row in a **Feishu Bitable** — categorized as **Requests** (Quotation / Sample / R&D Support) with notes and assigned to a Feishu **Coworker** — and keeps a recoverable **Email Record** in Convex. The Vite **SPA** runs in the Outlook taskpane; backend logic and data live in Convex. Forwarding an email *copy* into Feishu chat or via bot webhook — and the email-PDF / attachment / Feishu-Doc machinery — is **retired** ([ADR-0010](docs/adr/0010-pivot-to-bitable-intake.md)).

## Language

**SPA**:
The React + Vite static bundle loaded inside the Outlook taskpane iframe. The same source ships to two hosts: the **ECS Host** (built with base path `/addin/`, served at `https://<host>/addin/`) for the CN audience, and the **Global Host** (built with base `/`, served at `https://outlook-feishu-bridge.pages.dev/`) for everyone else ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)).
_Avoid_: "frontend" (overloaded), "client", "the addin" (manifest + SPA are different things).

**Outlook Manifest**:
The `OfficeApp` XML at [public/manifest.xml](public/manifest.xml) that Outlook reads to discover the add-in's display name, icons, command surfaces, and taskpane URL. Its `SourceLocation` / `Taskpane.Url` point at the host that serves the **SPA**. It ships with two placeholders — `__ADDIN_DOMAIN__` (the host) and `__ADDIN_BASE__` (the path prefix) — which **must be substituted before sideloading** via `scripts/manifest.sh <domain> [base]`; the raw token makes Outlook fail with "server IP address could not be found". There are two generated manifests, one per host: the **ECS Host** (`<host>` + `addin/`) for CN users, the **Global Host** (`outlook-feishu-bridge.pages.dev` + empty base) for everyone else. Changing a URL forces a manifest regen and re-sideload.
_Avoid_: "the addin config", "the XML".

**ECS Host**:
A single Aliyun ECS Ubuntu 24 instance (`__ADDIN_DOMAIN__`) running nginx. Its primary, steady-state job is serving the **SPA** as static files from `/var/www/addin` under location `/addin/`. It serves the **Mainland-China audience**; the **Global Host** (Cloudflare Pages) serves everyone else from the same codebase ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)) — so it no longer *replaces* Cloudflare (as ADR-0002 framed it), it runs alongside it. It also runs the **Fallback OAuth Callback** — a small Bun auth server behind nginx ([ADR-0008](docs/adr/0008-fallback-login-via-box.md)). It may *also* be used later as a reverse-proxy fallback to the **Convex Backend** if Mainland-China ↔ US connectivity degrades — that proxy is not built yet.
_Avoid_: "CDN" (there is no CDN in front of it today), "gateway" (it's a web server, not just a proxy), "the backend" (the backend is Convex).

**Global Host**:
The Cloudflare Pages deployment (`outlook-feishu-bridge.pages.dev`, base `/`) that serves the **SPA** to the **non-Mainland-China audience**, complementing the **ECS Host** from one codebase ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)). Static-only: it uses the primary **OAuth Callback** (host-independent, on `*.convex.site`) but has **no Fallback OAuth Callback** (no Bun server runs on Pages), and its Sentry ingest is direct (no `/_sentry/` tunnel). CSP + SPA fallback come from `public/_headers` + `public/_redirects`, the Cloudflare equivalents of the ECS nginx config.
_Avoid_: "Edge Host" (ADR-0001's superseded "CN Edge Gateway" already attached "edge" to the **ECS Host**), "the CDN", "the pages.dev".

**Atomic Release**:
The deploy mechanism on the **ECS Host**. `scripts/deploy.sh` unpacks each build into `/var/www/releases/<timestamp>/`, flips the `/var/www/addin` symlink to it, and prunes all but the newest 3 releases. Rollback = repoint the symlink at an older release dir.
_Avoid_: "the deploy folder".

**Convex Backend**:
The hosted Convex deployment (`steady-setter-706.convex.{cloud,site}`, project `feishu-route`). Performs the **Bitable Sync** write — a **tenant-identity call** to the Feishu Bitable API — and persists the **Email Record** (a recoverable backup / workflow history of each sync). Owns the schema, mutations, queries, and the primary **OAuth Callback** HTTP route. US-hosted; not migrating to Aliyun in this iteration.
_Avoid_: "the server" (it's a hosted backend, not the ECS box).

**OAuth Callback**:
The **primary** path that exchanges a Feishu authorization code for a user token: the HTTP route `GET /feishu/oauth/callback` on `*.convex.site` ([convex/http.ts:7](convex/http.ts:7)). Its URI is registered in the Feishu open-platform console and points directly at Convex. Because it is a Convex **HTTP action**, it shares fate with the Convex action runtime — when that is unavailable, login falls back to the **Fallback OAuth Callback** on the **ECS Host** ([ADR-0008](docs/adr/0008-fallback-login-via-box.md)).
_Avoid_: "the Feishu redirect".

**Fallback OAuth Callback**:
A second, separately-registered redirect URI `GET /feishu/oauth/callback` on the **ECS Host** (`https://<host>/…`), served by a zero-dependency **Bun** server ([server/feishu-auth/](server/feishu-auth/)) behind nginx — the same proxy pattern as the Sentry tunnel. It does the Feishu **v2** code→token exchange and returns the token to the **SPA** via the **Office Dialog API** (`messageParent`) — `window.open`/`postMessage` is unreliable in the Outlook taskpane, so the SPA opens it with `displayDialogAsync`. The SPA then holds the token in `localStorage` (no DB) and uses it for **Bitable Sync**'s only user-token need — searching **Coworkers**. A manual "trouble logging in?" path, used only when the **Convex Backend**'s action runtime is down. See [ADR-0008](docs/adr/0008-fallback-login-via-box.md).
_Avoid_: conflating it with the primary Convex **OAuth Callback** — two registered redirect URIs with different token models (DB vs browser-held).

**Feishu Open Platform**:
`open.feishu.cn`. Both an outbound API target — the **Bitable** write, called from Convex actions in `convex/feishu/*.ts` — and the OAuth identity provider (issues the redirect to **OAuth Callback**). Outbound calls go directly from Convex.

**Bitable Sync**:
The click→Feishu path the **SPA** orchestrates: read the open Outlook email, let the user record one or more **Requests**, assign exactly one **Coworker**, then Convex writes the **Bitable** row (tenant token) and stores the **Email Record**. One email → one row; nothing is messaged to anyone. The backend links a **Customer** when the sender domain matches the read-only **Customer Table**; the user can edit the email used for that match. If the user catches an error during the sync, that **just-created** row is updated in place (a `PUT` — [ADR-0012](docs/adr/0012-bitable-record-api.md)); the add-in never modifies any other or pre-existing Bitable row, and never modifies the **Customer Table** at all. An Outlook category tag is planned but deferred. (Replaces the retired multi-target "Forward pipeline" — [ADR-0010](docs/adr/0010-pivot-to-bitable-intake.md).)
_Avoid_: "forward" / "the forward pipeline" (we no longer forward an email copy — we extract a structured request), "send to chat".

**Request**:
A single categorized ask captured from the client email — one of **Quotation**, **Sample**, or **R&D Support** — with a free-text note ([RequestCards.tsx](src/components/taskpane/RequestCards.tsx)). One email can carry several; they become the Request Types / Request Notes columns of the **Bitable** row.
_Avoid_: "ticket", "channel" (an earlier word for these cards).

**Coworker**:
A Feishu directory user, found via **Search Users** (`/search/v1/user`, scope `contact:user:search`) and selected as the single **assignee** written into the **Bitable** row. Exactly one **Coworker** is required per **Bitable Sync**. The app sends them **no message** — assignment is metadata; any alerting is Bitable's own feature.
_Avoid_: "recipient" / "contact" (we don't deliver anything to them), "channel".

**Initiator**:
The signed-in Feishu user who clicks **Sync** — the salesperson who triggered the **Bitable Sync**. Distinct from the **Coworker** (the assignee). Written into the Bitable Service row's `Sales` (User) column and mirrored onto the **Email Record** as the audit trail of *who* synced it.
_Avoid_: "creator" (Bitable's auto-`创建人` column captures the tenant-bot identity, not the salesperson), "sender" (that's the email's `from`, the client side).

**Bitable**:
The Feishu multi-dimensional table (`FEISHU_BITABLE_APP_TOKEN` + `FEISHU_BITABLE_TABLE_ID`) that is the product's primary output. Each synced email is one row (Request Types, Request Notes, one Coworker, Date, and a link to a **Customer** when one is matched or chosen), written with the **tenant** token (app permission `bitable:app`).
_Avoid_: "the spreadsheet", "the database" (the record of record is Bitable; Convex holds a backup).

**Customer**:
A row in the **Customer Table** representing one business the company sells to — the entity the Bitable Service row's `Client` DuplexLink points at. Identified primarily by a name (primary field) and an email **`域名`** (domain) field used for auto-match.
_Avoid_: "client" (overloaded with `clientEmail` + the legacy `Client` column name), "buyer", "account".

**Customer Table**:
The sibling Feishu Bitable table `tbl4TE2GV472sKzp` in the same Base as the **Bitable** Service table — the directory of every **Customer** the company sells to. The add-in only **reads** it; per the HARD RULE it never modifies, creates, or deletes a Customer row.
_Avoid_: "client table", "customer base" (overloaded — the *Bitable Base* is the parent container, not this table).

**Email Record**:
The Convex-persisted copy of a synced request — a recoverable backup / workflow history of what was written to **Bitable** (email metadata, a body preview, the chosen **Requests** + the single **Coworker**, and the resulting `bitableRecordId`). The full email body is never stored — only a ≤500-char preview.
_Avoid_: "the email" (it's a derived record, not the original mail), "the PDF" (no PDF is produced anymore).

**Mail Item**:
The Outlook message the salesperson has open in the reading pane, accessed inside the **SPA** through Office.js as `Office.context.mailbox.item` (typed as `Office.MessageRead & Office.ItemRead`). The taskpane reads `subject`, `from`, `to`, `cc`, `dateTimeCreated`, `internetMessageId`, `itemId`, `conversationId`, and the **plain-text body** via `body.getAsync(Office.CoercionType.Text)`. Compose/reply mail items (which expose `subject` as a `Subject` object with `.getAsync`) are detected and rejected — this add-in only syncs received mail.
_Avoid_: "the mail", "the message" (overloaded), "the email" (the **Email Record** is the *persisted* derivative, the Mail Item is the *live* Office.js handle).

**User-identity call / tenant-identity call**:
The two Feishu token types. A **user-identity call** uses the signed-in person's user access token and is now used for exactly one thing — **searching the directory for Coworkers** (`/search/v1/user`). A **tenant-identity call** uses the app token and does the **Bitable** write.
_Avoid_: "the Feishu token" — there are two, user vs tenant.

## Relationships

- The **Outlook Manifest** points `SourceLocation` at whichever host serves the **SPA** (`https://<ECS Host>/addin/` for CN users, the **Global Host** root for everyone else).
- The **ECS Host** serves the **SPA** at `/addin/` (CN); the **Global Host** (Cloudflare Pages) serves the same **SPA** at root `/` to non-CN users, using the primary **OAuth Callback** only ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)).
- The **SPA** runs **Bitable Sync**: it calls the **Convex Backend** directly (WebSocket queries/mutations on `*.convex.cloud`, HTTP actions on `*.convex.site`).
- The **Convex Backend** makes the **tenant-identity** **Bitable** write to the **Feishu Open Platform**, then stores the **Email Record**.
- The **SPA** makes a **user-identity call** only to search **Coworkers**; login flows through the primary **OAuth Callback**, or the ECS **Fallback OAuth Callback** when Convex actions are down ([ADR-0008](docs/adr/0008-fallback-login-via-box.md)).
- The **ECS Host** *may later* reverse-proxy to the **Convex Backend** as a CN-resident fallback — not built today.

## Example dialogue

> **New engineer:** "So we forward the email into a Feishu chat?"
> **Domain expert:** "Not anymore. We do **sales-request intake**. The salesperson opens the client's email, tags it as one or more **Requests** — Quotation, Sample, R&D Support — with a note each, picks exactly one **Coworker** who should own it, and we write **one row** to the **Bitable**. That's the product."
> **New engineer:** "Does the coworker get pinged?"
> **Domain expert:** "No. The coworker is the **assignee** — a field in the row. We send no chat message; that whole path is retired ([ADR-0010](docs/adr/0010-pivot-to-bitable-intake.md)). If Bitable notifies on assignment, that's Bitable's doing, not ours."
> **New engineer:** "What's Convex for, then?"
> **Domain expert:** "Two jobs. It makes the **tenant-token** **Bitable** write, and it keeps an **Email Record** — a recoverable backup of what we synced. Bitable is the record of record; Convex is the safety net + workflow history."
> **New engineer:** "And the email PDF / attachments?"
> **Domain expert:** "Gone. We capture a body **preview** as a field; we don't render a PDF or upload attachments anymore ([ADR-0010](docs/adr/0010-pivot-to-bitable-intake.md))."

## Flagged ambiguities

- "Gateway" — earlier designs called the ECS box a "CN Edge Gateway" / warm-standby proxy (see superseded ADR-0001). It is now primarily a **web server** serving the SPA. Say **ECS Host**, not "gateway".
- "Convex" sometimes refers to the SaaS company, sometimes to our specific deployment. We say **Convex Backend** when we mean ours.
- The SPA base path is **host-specific**: `/addin/` on the **ECS Host**, `/` on the **Global Host** ([ADR-0009](docs/adr/0009-cloudflare-global-host-dual-deploy.md)). A mismatch — an ECS manifest pointing at root, or a `/addin/` build deployed to the Global Host's root — 404s on assets.
- `/search/v1/user` reads as legacy but is **current** — it's the official Search Users API (GET, keyword in the `query` URL param, scope `contact:user:search`); there is no `contact/v3` search ([ADR-0003](docs/adr/0003-feishu-user-scopes-and-search-v1.md)). It is still used — by **Coworker** search.
- **Bitable Sync** scopes: a user token needs `contact:user:search` + `offline_access` only; the chat scopes `im:chat:readonly` / `im:message` were **dropped** with the pivot ([ADR-0010](docs/adr/0010-pivot-to-bitable-intake.md)). The **Bitable** write itself is tenant-token (app permission `bitable:app`), not a user scope. Changing the user scope set forces every user to log out and re-authorize.
- **The UI is wired to Bitable Sync.** The redesigned taskpane ([RequestIntakeScreen.tsx](src/components/taskpane/RequestIntakeScreen.tsx) → [SyncScreen.tsx](src/components/taskpane/SyncScreen.tsx)) calls `requestSync.syncRequest`; "Synced to Feishu" means the Bitable write and Convex **Email Record** action resolved.
- **"Forward" is retired language.** The multi-target Forward pipeline has been removed from live code. Prefer **Bitable Sync** in prose.
- **"Client" survives only as the literal Bitable column name and the temporary `clientEmail` argument.** The Service row in the live Bitable has a DuplexLink column literally named `Client`; renaming that is a Base-side schema change that has to be done in Feishu, not from the SPA, and the value string must match exactly or the write fails. Everywhere else, prose should say **Customer**.
