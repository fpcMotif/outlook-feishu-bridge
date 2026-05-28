# Bitable record writes use the official Feishu Bitable v1 record API (create + update)

> **Status: accepted.** Extends [ADR-0010](0010-pivot-to-bitable-intake.md) (Bitable intake) and [ADR-0011](0011-feishu-permission-set.md) (permissions). Every endpoint, field format, and permission below is taken from the **official Feishu Open Platform** docs (cited inline) — the *only* source of truth for this integration. No third-party wrappers.

Bitable Sync writes one row per synced email, with exactly one selected Feishu **Coworker**, and — per the spec — must support an **immediate correction-update** of *that just-created row* (when the user spots an error during the sync). The add-in does **not** edit any other or pre-existing row. Both create and that correction-update use the official *Bitable v1 → app-table-record* API.

## The verified contract

**Create a record** — `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records`
- Query (optional): `user_id_type` (default `open_id`), `client_token` (a uuidv4 → **idempotent create**), `ignore_consistency_check`.
- Body: `{ "fields": { "<field name>": <value> } }`. Response: `data.record.record_id`.
- Ref: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create

**Update a record** — `PUT /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`
- Body: `{ "fields": { … } }` — same shape as create; only the named fields change.
- Ref: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update
- Batch (≤500): https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/batch_update

**Field value formats** in `fields` (official create example): text→`string`, number→`number`, single-select→`string`, multi-select→`string[]`, date/datetime→**epoch milliseconds** `number`, checkbox→`boolean`, person/人员→`[{ "id": "<open_id>" }]`.
- **Two-way link / DuplexLink (type 21)** → an **array of linked `record_id` strings** (`["rec…"]`, one element for a single link). **User (type 11)** → `[{ "id": "<open_id>" }]`. Verified against the official Feishu SDK (`larksuite/oapi-sdk-go`, `larksuite/node-sdk`) because the doc pages are JS-rendered and WebFetch can't read them.
- Record data structure ref: https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview ; SDK ref: https://github.com/larksuite/oapi-sdk-go

**Search records** (to resolve a link target) — `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search`, body `{ "filter": { "conjunction": "and", "conditions": [{ "field_name": "<name>", "operator": "is", "value": ["<text>"] }] } }`. `operator: "is"` = equals; `value` is a string array (official SDK `FilterInfo`/`Condition`).
- Refs: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search ; https://github.com/larksuite/oapi-sdk-go

**Permission:** `bitable:app` (broad) covers **both** `base:record:create` and `base:record:update`, so the [ADR-0011](0011-feishu-permission-set.md) scope already supports update — no change.

## Consequences

- **Update needs the `record_id`.** We persist `bitableRecordId` on the Email Record after create, so updating the row we created is a `PUT` with that id — no lookup.
- **`client_token` gives idempotent create** — a retried create with the same uuidv4 won't duplicate the row.
- **`Co Worker` is a person (人员) field.** [bitable.ts](../../convex/feishu/bitable.ts) writes the single selected Coworker in the official user-field format `[{ id: open_id }]`. `Date of Offer` is epoch-ms.
- **Update is a bounded in-sync correction only.** The add-in updates *only* the row it just created in the current sync session: if the user spots an error during/just after the sync, it PUTs the corrected `fields` to that `bitableRecordId`. It does **not** edit other or historical rows — the add-in is not permitted to modify pre-existing data. Lifecycle: create on first write → optional immediate correction-update of that same record. (A general edit/upsert-by-email model was explicitly rejected.)

## Client linkage (domain match)

`Client` is a DuplexLink (type 21) to the customer table `tbl4TE2GV472sKzp`, which has a `域名` (domain-name) Text field. On create we identify the client by **email domain**:

1. Take the client email (the email sender) and extract the domain (`name@acme.de` → `acme.de`).
2. **Search** the customer table where `域名` `is` that domain (read-only).
3. **Match** → set `Client` = `[clientRecordId]`.
4. **No match** → leave `Client` unlinked; the client's email is still retained on the Convex **Email Record** (email detail lives only in Convex, never in Bitable). Intentionally lenient — richer domain-matching rules will be supplied later, so the matcher must stay easy to extend.

The add-in **only reads** (searches) the customer table — it never creates or edits a customer row, and never touches a pre-existing row in any table.

## Why official-only

Third-party Feishu wrappers drift from the live API, and the field-value formats (person arrays, datetime-as-ms) and create-vs-update paths are easy to get subtly wrong. Every endpoint here is cited to open.feishu.cn so a future reader can re-verify. This is the standing rule for all Feishu code in this repo.
