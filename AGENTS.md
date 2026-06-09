<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Convex guidelines — cited, quoted, and project overrides

> **Why this section is safe.** The block above between `<!-- convex-ai-start -->` and `<!-- convex-ai-end -->` is **auto-managed** by `bunx convex ai-files update` — anything inside it (including the `bun`/`bunx` line) is overwritten on update. This section is **hand-maintained and lives OUTSIDE those markers**, so it survives updates. Full ruleset / source of truth: [`convex/_generated/ai/guidelines.md`](convex/_generated/ai/guidelines.md) — read it first when touching `convex/`.

### Load-bearing rules quoted from `guidelines.md`
- **Validators:** *"ALWAYS include argument validators for all Convex functions"* — `query`, `internalQuery`, `mutation`, `internalMutation`, `action`, `internalAction`.
- **Registration:** `internal{Query,Mutation,Action}` for private (Convex-only) functions; bare `query/mutation/action` are the **public, Internet-facing API** — *"Do NOT use `query`, `mutation`, or `action` to register sensitive internal functions."*
- **Calling functions:** `ctx.runQuery/runMutation/runAction` take a **`FunctionReference`** (the `api`/`internal` objects from `_generated/api`), never the callee itself. Annotate the return type on **same-file** calls (TS circularity). *"Only call an action from another action if you need to cross runtimes (V8 → Node); otherwise pull out a shared helper."* Minimise action→query/mutation calls (each is its own transaction → race risk).
- **Queries:** *"Do NOT use `filter` in queries"* — define an index and use `withIndex`. Return **bounded** results (`.take()` / `.paginate()`), not `.collect()`. Index names list every field (`by_field1_and_field2`) and are queried in defined order. `.unique()` throws on >1 match. No `.delete()` on a query; no `.collect().length` for counts.
- **Mutations:** `ctx.db.patch` (shallow-merge) and `ctx.db.replace` (full) both throw if the doc is missing.
- **Actions:** add `"use node";` **only** for Node built-ins, and **never** in a file that also exports queries/mutations; `fetch()` needs no `"use node"`; *"Never use `ctx.db` inside of an action."*
- **Schema:** `_id` (`v.id`) + `_creationTime` (`v.number`) are auto-added system fields. Don't store unbounded arrays in a doc (1 MB cap) — use a child table + foreign key. Separate high-churn fields into their own table.
- **Crons:** only `crons.interval` / `crons.cron` (not the hourly/daily/weekly helpers); pass a `FunctionReference`; import `internal` even for same-file targets.
- **File storage:** read metadata from the `_storage` system table via `ctx.db.system.get` — **not** the deprecated `ctx.storage.getMetadata`; stored items are `Blob`s.
- **Types & values:** `undefined` is **not** a valid Convex value — return `null`. Use `Id<'table'>` / `Doc<'table'>` and `QueryCtx`/`MutationCtx`/`ActionCtx`; never `any` for `ctx`.

### Project overrides — these WIN where they conflict with `guidelines.md`
- **Testing: this project does NOT use `convex-test`.** `guidelines.md` §Testing recommends `convex-test` + `@edge-runtime/vm` — **ignore that here.** Registered Convex handlers are `v8-ignore`d; business logic is extracted into pure helpers and unit-tested with plain `vitest` (the extract-then-test seam, ADR-0019). **Never run the full `bun run test`** — use scoped `bunx vitest run <file>` only.
- **Package commands: `bun` / `bunx` only — never `npm` / `npx`.** Any `npx convex …` hint (including ones printed by `ai-files`) → run `bunx convex …`. (Also stated inside the managed block above, but kept here so it survives an `ai-files update`.)
- **Bitable writes ride the create path only** — never modify/update/delete a pre-existing row, and never write the Feishu-owned **`Request Type`** column (`convex/feishu/serviceRow.ts`; ADR-0012 / ADR-0022). Confirm live column names with `bunx convex run feishu/bitable:listFields` before changing any column constant.
