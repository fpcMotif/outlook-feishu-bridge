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

## Consequences

- **Releasing a new app version is required** before a permission change takes effect, and every signed-in user must **re-authorize** (Feishu grants only the scopes present at authorize time — [ADR-0003](0003-feishu-user-scopes-and-search-v1.md)).
- **The app must be a collaborator (edit) on the target Base**, or the tenant write fails even with `bitable:app`.
- **`bitable:app` is tenant-wide** — it grants access to every Base the tenant can reach, not just the target table. Accepted for now; revisit with granular `base:*` scopes if least privilege becomes a requirement.
- **The fallback login server's scope default** (`server/feishu-auth/index.ts` + `scripts/deploy.sh`) is also `contact:user:search offline_access`; redeploy the ECS fallback path when changing this scope set.

## Alternatives rejected

- **Granular `base:record:create`.** Least privilege, but the identifier needs console verification, would need expanding for any future read/update feature, and risks a batch-import rejection mid-test. Deferred to a hardening pass.
- **Grant `bitable:app` to the user identity too.** Unnecessary — the write is tenant-only; adding it would force a needless re-authorization.

## Amendment (2026-06-01) — Optional tenant Contact read scope for Coworker Directory

The baseline permission set remains tenant `bitable:app` + user `contact:user:search` + OAuth `offline_access`. A small-org **Coworker Directory** mirror can be enabled to remove almost all live Search Users calls during typing, but it requires extra Feishu console configuration and must be treated as opt-in.

When enabling `FEISHU_COWORKER_DIRECTORY_SYNC=1`:

- Grant the tenant Contact API permissions required by Feishu's **Get department direct users** and **Get child departments** pages, and set the app's contact visibility range to cover all members if querying root department `0`.
- Do **not** remove user `contact:user:search`; it remains the live fallback when the directory is absent, stale, disabled, or unauthorized.
- Do **not** request sensitive field scopes such as phone, email, employee ID, or user ID unless a product requirement needs them. The mirror stores only `open_id`, `name`, and avatar URL, so `user_id_type=open_id` is enough.

Official refs:

- https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department
- https://open.feishu.cn/document/server-docs/contact-v3/department/children
