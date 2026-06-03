# Feishu permission set for Base intake: tenant `bitable:app` + user `contact:user:search`

> **Status: accepted.** Concretizes the scope narrowing in [ADR-0010](0010-pivot-to-bitable-intake.md); amends [ADR-0003](0003-feishu-user-scopes-and-search-v1.md).

After the Base-intake pivot ([ADR-0010](0010-pivot-to-bitable-intake.md)) the app needs exactly two Feishu permissions — granted to *different* identities — plus one OAuth-only scope. They are batch-configured in the developer console (权限管理 → import JSON):

```json
{
  "scopes": {
    "tenant": ["bitable:app"],
    "user": ["contact:user:search"]
  }
}
```

## Decision

- **`bitable:app` on the _tenant_ identity.** The Base row write ([bitable.ts](../../convex/feishu/bitable.ts), `auth: "tenant"`) uses the tenant token, so the permission is granted to the app identity. We picked the **broad** `bitable:app` (查看、评论、编辑和管理多维表格) over the granular `base:record:create`: it is certain to cover `createRecord`, matches the console's named permission, and avoids a wrong-identifier batch-import failure during the test phase.
- **`contact:user:search` on the _user_ identity.** Coworker search ([coworkers.ts](../../convex/feishu/coworkers.ts), `/search/v1/user`) is the only remaining user-token call; it is requested in the authorize URL ([useFeishuAuth.ts](../../src/hooks/useFeishuAuth.ts)).
- **`offline_access` is authorize-URL-only.** It is **not** a console permission and must **not** appear in the batch JSON — it is an OAuth scope sent in the authorize request so the OIDC token endpoint returns a refresh token ([ADR-0003](0003-feishu-user-scopes-and-search-v1.md)).
- **`im:chat:readonly` and `im:message` dropped** with the chat retirement ([ADR-0010](0010-pivot-to-bitable-intake.md)).

## What the single `bitable:app` tenant scope covers (verified against open.feishu.cn, 2026-06-03)

Every Base call the add-in makes rides on `bitable:app` — **no granular `base:*` and no `drive:*` grant is needed**. Each endpoint doc lists its scopes as "开启任一权限即可调用" (enable **any one** of …), and `bitable:app` is always one of them:

| Call (file) | Endpoint | Op | Scope doc (any-one-of incl. `bitable:app`) |
|---|---|---|---|
| `createServiceRecord` ([bitable.ts](../../convex/feishu/bitable.ts)) | POST …/records | write | [record/create](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create) (`base:record:create` \| `bitable:app`) |
| `correctServiceRecord` ([bitable.ts](../../convex/feishu/bitable.ts)) | PUT …/records/{record_id} | update | [record/update](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update) (`base:record:update` \| `bitable:app`) |
| Client/Customer search ([bitable.ts](../../convex/feishu/bitable.ts), customers.ts, customersMirror.ts) | POST …/records/search | search | [record/search](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search) (`base:record:retrieve` \| `bitable:app(:readonly)`) |
| `listFields` ([bitable.ts](../../convex/feishu/bitable.ts)) | GET …/fields | read | [field/list](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list) (`base:field:read` \| `bitable:app(:readonly)`) |
| attachment upload ([drive.ts](../../convex/feishu/drive.ts)) | POST /drive/v1/medias/upload_all (`parent_type=bitable_file`) | upload | [media/upload_all](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all) (`bitable:app` \| docs/drive/sheets) — **no `drive:*` needed**; rate-limited 5 QPS, see [ADR-0022](0022-attachments-and-mail-body-to-base-row.md) |

**Error triage — three distinct failure surfaces (do not chase the wrong fix):**
1. **Gateway scope denial** — `99991672` "Access denied. One of the following scopes is required: […]" (the missing scope is echoed in `error.permission_violations`); Drive's endpoint-level variant is `1061073` "no scope auth." → grant/enable the scope.
2. **Base ACL denial** — `1254302` / `1254304` "Permission denied." (高级权限/可管理权限) → the app must be an **edit collaborator** on the target Base; this is *not* an OAuth scope.
3. **Data error** — `1254045` `FieldNameNotFound` (wrong/renamed column) and `1254066` `UserFieldConvFail` (bad value for a User field, e.g. an invalid `open_id`) → the request *was* authorized; fix the **payload**, never the scope.

> The Contacts Mirror ([ADR-0023](0023-feishu-contacts-mirror.md)) is the one feature this scope does **not** cover — it needs a separate tenant `contact:contact:readonly_as_app` base scope plus the `contact:user.{base,department,employee}:readonly` field scopes, none yet granted (the cron hits `99991672` until they are).

## Consequences

- **Releasing a new app version is required** before a permission change takes effect, and every signed-in user must **re-authorize** (Feishu grants only the scopes present at authorize time — [ADR-0003](0003-feishu-user-scopes-and-search-v1.md)).
- **The app must be a collaborator (edit) on the target Base**, or the tenant write fails even with `bitable:app`.
- **`bitable:app` is tenant-wide** — it grants access to every Base the tenant can reach, not just the target table. Accepted for now; revisit with granular `base:*` scopes if least privilege becomes a requirement.
- **The fallback login server's scope default** (`server/feishu-auth/index.ts` + `scripts/deploy.sh`) is also `contact:user:search offline_access`; redeploy the ECS fallback path when changing this scope set.

## Alternatives rejected

- **Granular `base:record:create`.** Least privilege, but the identifier needs console verification, would need expanding for any future read/update feature, and risks a batch-import rejection mid-test. Deferred to a hardening pass.
- **Grant `bitable:app` to the user identity too.** Unnecessary — the write is tenant-only; adding it would force a needless re-authorization.
