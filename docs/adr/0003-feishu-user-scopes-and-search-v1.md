# Feishu user-data calls use user_access_token + explicit OAuth scopes; Search Users stays on /search/v1/user

> **Status: accepted.**

The bridge lists the signed-in user's groups, searches the directory, and forwards mail **as that user** — so those calls use a **user access token**, not the app/bot (tenant) token. Feishu only puts a user-identity scope into the token if it is named in the OAuth `authorize` request's `scope` parameter; our login originally sent **no** `scope`, so every user-identity call failed with **`99991679`** ("app did not obtain the user's authorization"). The login now requests `im:chat:readonly contact:user:search im:message offline_access` — all already enabled on app `cli_a945ac390ff9dcc0`.

## On the `v1` in `/open-apis/search/v1/user`

`GET /open-apis/search/v1/user` (keyword in the `query` URL param, scope `contact:user:search`, `user_access_token`) is the **current** official Search Users API — verified directly against the open.feishu.cn docs (both the `contact-v3/user/search-users` page and the older page; neither carries a deprecation / 旧版 banner). The `v1` is **not** legacy and there is **no** `contact/v3` search-users replacement. Do not "upgrade" the path.

The real defect was the *call shape*: `contacts.ts` issued a **POST with the keyword in a JSON body** and read a non-existent `avatar_url`. Fixed to a **GET** with `?query=`, mapping `avatarUrl` from the `avatar.avatar_72` object field.

## Consequences

- **Scope changes force re-login.** Adding or removing a requested scope only takes effect after each user logs out and re-authorizes; tokens minted earlier keep their old scope set.
- **`offline_access` is load-bearing.** Once `scope` is sent explicitly, the OIDC token endpoint returns a `refresh_token` only when `offline_access` is among the requested scopes — dropping it would break `userAuth`'s silent refresh.
- **Least privilege.** We request only the scopes actually exercised; `contact:user.base:readonly` was dropped as unused (Search Users returns name/avatar/open_id under `contact:user:search` alone; `user_id` would need `contact:user.employee_id:readonly`, which we don't use).
- **Tenant-identity calls are unaffected.** Bot-webhook posts, Doc creation, and Bitable writes use the tenant token and were never implicated in `99991679`.
