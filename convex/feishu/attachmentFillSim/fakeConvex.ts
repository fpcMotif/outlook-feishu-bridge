/* eslint-disable max-lines, max-classes-per-file, require-await, no-inline-comments, unicorn/no-array-callback-reference, unicorn/no-array-sort, unicorn/prefer-type-error -- test-support harness: a cohesive in-memory Convex fake; async methods mirror the real ctx signatures (no await needed); the structural caps do not apply to a single-purpose simulator. */
// In-memory Convex runtime for the deferred Attachment Fill simulation harness
// (ADR-0027). Reproduces the Convex contracts the SUT relies on — faithfully,
// because the whole adversarial suite is anchored on these semantics:
//
//   • ctx.db.patch is a SHALLOW MERGE, and a key set to `undefined` DELETES that
//     field (the SUT uses this for the next-retry / heartbeat sentinels).
//   • ctx.db.insert assigns a unique `_id` + numeric `_creationTime` and stores a
//     deep copy (callers cannot mutate the stored doc by reference).
//   • Index ordering: a MISSING / `undefined` indexed field sorts BELOW every
//     number and string (the "undefined sorts lowest" footgun). So a `.gte(0)`
//     range EXCLUDES rows whose indexed field is undefined — exactly what
//     listDueBitableSyncRecords leans on.
//   • ctx.runQuery / runMutation / runAction resolve a Convex FunctionReference
//     (an `internal.*` proxy) to the real registered handler and invoke it with
//     the unified harness ctx. Unregistered refs throw loudly so pipeline gaps
//     surface in the test, never silently no-op.
//   • ctx.scheduler.runAfter enqueues a due-stamped job (dueAt = now + delayMs);
//     the harness drives the queue forward deterministically under fake timers.
//
// Pure TypeScript: NO `vitest` import (this file is linted as production code and
// is also seen by Convex bundling).

import { getFunctionName } from "convex/server";

// ===========================================================================
// Time
// ===========================================================================

/**
 * The harness clock. Reads the SAME wall clock the real handlers read
 * (`Date.now()`), so a test driving `vi.setSystemTime(...)` moves both the SUT's
 * freshness/fence math and the scheduler's due math together.
 */
export interface HarnessClock {
  now(): number;
}

export const wallClock: HarnessClock = {
  now: () => Date.now(),
};

// ===========================================================================
// Function-reference registry (ref -> real handler)
// ===========================================================================

/**
 * A Convex registered function exposes its body as `._handler` (a runtime
 * property not in its public type — reached via the ADR-0019 cast seam). We
 * accept the registered fn as `unknown` at the boundary and pull `._handler`
 * off it, exactly as the existing extract-then-test tests do.
 */
type RegisteredFn = unknown;
type HandlerCarrier = { _handler?: (ctx: unknown, args: unknown) => unknown };

/** A Convex FunctionReference (the `internal.*` / `api.*` proxy objects). */
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

/** Thrown when the dispatcher is asked to run a ref it has no handler for. */
export class UnregisteredFunctionError extends Error {
  readonly functionName: string;
  constructor(functionName: string) {
    super(
      `Harness Registry has no handler for "${functionName}". ` +
        `Register it in createHarness() so the pipeline call resolves; ` +
        `an unregistered ref means a gap in the simulated pipeline.`,
    );
    this.name = "UnregisteredFunctionError";
    this.functionName = functionName;
  }
}

/**
 * Maps every Convex FunctionReference the pipeline calls to its real
 * `._handler`, keyed by the canonical function name (`module:fn`). The
 * `internal.*` proxies do NOT preserve object identity across property
 * accesses, so we resolve by the stable `getFunctionName(ref)` string rather
 * than `===` — same guarantee, robust to proxy churn.
 */
export class Registry {
  private readonly handlers = new Map<
    string,
    (ctx: unknown, args: unknown) => unknown
  >();

  /** Register a real registered Convex fn under its own canonical name. */
  register(ref: AnyFunctionReference, fn: RegisteredFn): this {
    const name = nameOf(ref);
    const handler = (fn as HandlerCarrier)?._handler;
    if (typeof handler !== "function") {
      throw new Error(
        `Cannot register "${name}": the value has no callable ._handler ` +
          `(did you pass the module export rather than the registered function?).`,
      );
    }
    this.handlers.set(name, handler.bind(fn));
    return this;
  }

  /** Resolve a ref to its handler, or throw a named error on a miss. */
  resolve(ref: AnyFunctionReference): (ctx: unknown, args: unknown) => unknown {
    const name = nameOf(ref);
    const handler = this.handlers.get(name);
    if (!handler) throw new UnregisteredFunctionError(name);
    return handler;
  }

  has(ref: AnyFunctionReference): boolean {
    return this.handlers.has(nameOf(ref));
  }

  /** All registered canonical names (for diagnostics / discoverability). */
  names(): string[] {
    // eslint-disable-next-line react-doctor/js-tosorted-immutable -- test diagnostics accessor over a tiny in-memory set; clarity over micro-perf
    return [...this.handlers.keys()].sort();
  }
}

function nameOf(ref: AnyFunctionReference): string {
  try {
    return getFunctionName(ref);
  } catch {
    throw new Error(
      "Value is not a Convex FunctionReference (expected an internal.* / api.* ref).",
    );
  }
}

// ===========================================================================
// FakeDb — the emailRecords table + its five indexes
// ===========================================================================

/**
 * A stored document: caller fields plus the system fields Convex stamps. We
 * keep the document type loose (`Record<string, unknown>`) because the harness
 * is table-agnostic; the SUT only ever touches `emailRecords`.
 */
export type FakeDoc = Record<string, unknown> & {
  _id: string;
  _creationTime: number;
};

/** A query builder op recorded against the index range. */
interface IndexBound {
  field: string;
  op: "eq" | "gte" | "lte";
  value: unknown;
}

/**
 * "undefined sorts lowest" comparator. Mirrors Convex index ordering: a missing
 * / undefined value sorts strictly below every concrete value; numbers and
 * strings compare naturally; equal values fall back to `_creationTime` then
 * `_id` for a total, stable order.
 */
function compareValues(a: unknown, b: unknown): number {
  const au = a === undefined;
  const bu = b === undefined;
  if (au && bu) return 0;
  if (au) return -1; // undefined < anything
  if (bu) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Does `value` satisfy the bound under the undefined-sorts-lowest ordering? */
function satisfiesBound(value: unknown, bound: IndexBound): boolean {
  const cmp = compareValues(value, bound.value);
  switch (bound.op) {
    case "eq":
      // `.eq(field, undefined)` matches only undefined; otherwise exact match.
      return cmp === 0;
    case "gte":
      // KEY footgun: `.gte(0)` excludes undefined because undefined < 0.
      return cmp >= 0;
    case "lte":
      return cmp <= 0;
    default:
      return false;
  }
}

class FakeIndexQuery {
  private readonly bounds: IndexBound[] = [];
  private direction: "asc" | "desc" = "asc";

  constructor(
    private readonly rows: () => FakeDoc[],
    private readonly indexFields: readonly string[],
  ) {}

  eq(field: string, value: unknown): this {
    this.assertField(field, "eq");
    this.bounds.push({ field, op: "eq", value });
    return this;
  }

  gte(field: string, value: unknown): this {
    this.assertField(field, "gte");
    this.bounds.push({ field, op: "gte", value });
    return this;
  }

  lte(field: string, value: unknown): this {
    this.assertField(field, "lte");
    this.bounds.push({ field, op: "lte", value });
    return this;
  }

  private assertField(field: string, op: string): void {
    if (!this.indexFields.includes(field)) {
      throw new Error(
        `Index range .${op}("${field}") is not part of index [${this.indexFields.join(", ")}]`,
      );
    }
  }

  // ---- terminals / modifiers -------------------------------------------

  order(direction: "asc" | "desc"): this {
    this.direction = direction;
    return this;
  }

  private materialize(): FakeDoc[] {
    const matched = this.rows().filter((row) =>
      this.bounds.every((bound) => satisfiesBound(row[bound.field], bound)),
    );
    matched.sort((a, b) => {
      for (const field of this.indexFields) {
        const c = compareValues(a[field], b[field]);
        if (c !== 0) return c;
      }
      const ct = compareValues(a._creationTime, b._creationTime);
      if (ct !== 0) return ct;
      return compareValues(a._id, b._id);
    });
    if (this.direction === "desc") matched.reverse();
    return matched;
  }

  async first(): Promise<FakeDoc | null> {
    const all = this.materialize();
    return all.length > 0 ? deepCopy(all[0]) : null;
  }

  async unique(): Promise<FakeDoc | null> {
    const all = this.materialize();
    if (all.length > 1) {
      throw new Error("unique() found more than one matching document");
    }
    return all.length === 1 ? deepCopy(all[0]) : null;
  }

  async take(n: number): Promise<FakeDoc[]> {
    return this.materialize().slice(0, n).map(deepCopy);
  }

  async collect(): Promise<FakeDoc[]> {
    return this.materialize().map(deepCopy);
  }
}

class FakeTableQuery {
  constructor(
    private readonly rows: () => FakeDoc[],
    private readonly indexes: Record<string, readonly string[]>,
  ) {}

  withIndex(
    indexName: string,
    rangeFn?: (q: FakeIndexQuery) => FakeIndexQuery,
  ): FakeIndexQuery {
    const fields = this.indexes[indexName];
    if (!fields) {
      throw new Error(`Unknown index "${indexName}" on emailRecords`);
    }
    const q = new FakeIndexQuery(this.rows, fields);
    return rangeFn ? rangeFn(q) : q;
  }

  // A bare `.query(table).order('desc').take(n)` (used by listRecent) — orders
  // by _creationTime, the default Convex full-table order.
  order(direction: "asc" | "desc"): FakeIndexQuery {
    return new FakeIndexQuery(this.rows, []).order(direction);
  }

  async take(n: number): Promise<FakeDoc[]> {
    return new FakeIndexQuery(this.rows, []).take(n);
  }
}

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The emailRecords indexes the SUT queries, declared exactly as in
 * convex/schema.ts (field order is load-bearing for index range semantics).
 */
export const EMAIL_RECORD_INDEXES: Record<string, readonly string[]> = {
  by_internetMessageId: ["internetMessageId"],
  by_conversationId: ["conversationId"],
  by_userEmail: ["userEmail"],
  by_requestSyncKey: ["requestSyncKey"],
  by_bitableSyncStatus_and_bitableNextRetryAt: [
    "bitableSyncStatus",
    "bitableNextRetryAt",
  ],
  by_attachmentStatus_and_attachmentNextRetryAt: [
    "bitableAttachmentStatus",
    "attachmentNextRetryAt",
  ],
};

export class FakeDb {
  private readonly tables = new Map<string, FakeDoc[]>();
  private seq = 0;

  constructor(private readonly clock: HarnessClock = wallClock) {}

  query(table: string): FakeTableQuery {
    const indexes = table === "emailRecords" ? EMAIL_RECORD_INDEXES : {};
    return new FakeTableQuery(() => this.rowsOf(table), indexes);
  }

  async get(id: string): Promise<FakeDoc | null> {
    const row = this.findById(id);
    return row ? deepCopy(row) : null;
  }

  async insert(table: string, doc: Record<string, unknown>): Promise<string> {
    this.seq += 1;
    const _id = `${table}_${this.seq}`;
    const stored: FakeDoc = {
      ...stripUndefined(deepCopy(doc)),
      _id,
      _creationTime: this.clock.now() + this.seq * 1e-6,
    };
    this.rowsOf(table).push(stored);
    return _id;
  }

  /**
   * SHALLOW MERGE patch with Convex's delete-on-undefined contract: a key whose
   * value is `undefined` removes that field from the stored doc. Throws if the
   * doc is missing (matching ctx.db.patch).
   */
  async patch(id: string, partial: Record<string, unknown>): Promise<void> {
    const row = this.findById(id);
    if (!row) throw new Error(`patch: document ${id} not found`);
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) {
        delete row[key];
      } else {
        row[key] = deepCopy(value);
      }
    }
  }

  /** Full replace (keeps system fields). Throws if the doc is missing. */
  async replace(id: string, doc: Record<string, unknown>): Promise<void> {
    const row = this.findById(id);
    if (!row) throw new Error(`replace: document ${id} not found`);
    const { _id, _creationTime } = row;
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, stripUndefined(deepCopy(doc)), { _id, _creationTime });
  }

  async delete(id: string): Promise<void> {
    for (const rows of this.tables.values()) {
      // eslint-disable-next-line react-doctor/js-index-maps -- simulation FakeDb scans its few in-memory tables; an id index would over-engineer test infra
      const idx = rows.findIndex((r) => r._id === id);
      if (idx >= 0) {
        rows.splice(idx, 1);
        return;
      }
    }
  }

  // ---- test accessors ---------------------------------------------------

  /** All rows in a table (deep copies; safe to read in assertions). */
  all(table: string): FakeDoc[] {
    return this.rowsOf(table).map(deepCopy);
  }

  count(table: string): number {
    return this.rowsOf(table).length;
  }

  private rowsOf(table: string): FakeDoc[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  private findById(id: string): FakeDoc | undefined {
    for (const rows of this.tables.values()) {
      // eslint-disable-next-line react-doctor/js-index-maps -- simulation FakeDb scans its few in-memory tables (test infra)
      const found = rows.find((r) => r._id === id);
      if (found) return found;
    }
    return undefined;
  }
}

/** Drop keys whose value is `undefined` — Convex never stores undefined. */
function stripUndefined(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ===========================================================================
// FakeStorage — staged blobs keyed by storageId
// ===========================================================================

export class FakeStorage {
  private readonly blobs = new Map<string, ArrayBuffer>();
  private seq = 0;

  /** Stage raw bytes and return an opaque storageId (as the SPA upload would). */
  stage(bytes: ArrayBuffer, idHint?: string): string {
    this.seq += 1;
    const id = idHint ?? `kg_${this.seq}`;
    this.blobs.set(id, bytes);
    return id;
  }

  /** Mirror of getStorageBytes: returns the ArrayBuffer or throws (dead/GC'd). */
  async getBytes(storageId: string): Promise<ArrayBuffer> {
    const bytes = this.blobs.get(storageId);
    if (!bytes) throw new Error("Storage file not found");
    return bytes;
  }

  /** ctx.storage.delete — idempotent removal of a staged blob. */
  async delete(storageId: string): Promise<void> {
    this.blobs.delete(storageId);
  }

  has(storageId: string): boolean {
    return this.blobs.has(storageId);
  }

  ids(): string[] {
    return [...this.blobs.keys()];
  }

  size(): number {
    return this.blobs.size;
  }
}

// ===========================================================================
// FakeScheduler — the runAfter queue, drained deterministically
// ===========================================================================

export interface ScheduledJob {
  id: string;
  dueAt: number;
  ref: AnyFunctionReference;
  refName: string;
  args: unknown;
}

export class FakeScheduler {
  private readonly queue: ScheduledJob[] = [];
  private seq = 0;

  constructor(private readonly clock: HarnessClock = wallClock) {}

  /** ctx.scheduler.runAfter — enqueue a job due at now + delayMs. */
  async runAfter(
    delayMs: number,
    ref: AnyFunctionReference,
    args: unknown,
  ): Promise<string> {
    this.seq += 1;
    const id = `job_${this.seq}`;
    this.queue.push({
      id,
      dueAt: this.clock.now() + delayMs,
      ref,
      refName: safeName(ref),
      args,
    });
    return id;
  }

  /** ctx.scheduler.runAt — enqueue a job due at an absolute timestamp. */
  async runAt(
    timestamp: number,
    ref: AnyFunctionReference,
    args: unknown,
  ): Promise<string> {
    this.seq += 1;
    const id = `job_${this.seq}`;
    this.queue.push({ id, dueAt: timestamp, ref, refName: safeName(ref), args });
    return id;
  }

  /** All currently-queued jobs (oldest first), as a read-only snapshot. */
  pending(): ScheduledJob[] {
    return [...this.queue];
  }

  /** Jobs due at or before `at` (defaults to the current clock). */
  due(at: number = this.clock.now()): ScheduledJob[] {
    return this.queue.filter((j) => j.dueAt <= at);
  }

  /** Pop the earliest job that is due at or before `at`, or null. */
  popDue(at: number = this.clock.now()): ScheduledJob | null {
    let bestIdx = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const j = this.queue[i];
      if (j.dueAt > at) continue;
      if (bestIdx < 0 || j.dueAt < this.queue[bestIdx].dueAt) bestIdx = i;
    }
    if (bestIdx < 0) return null;
    return this.queue.splice(bestIdx, 1)[0];
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  clear(): void {
    this.queue.length = 0;
  }
}

function safeName(ref: AnyFunctionReference): string {
  try {
    return getFunctionName(ref);
  } catch {
    return "(unknown ref)";
  }
}

// ===========================================================================
// buildHarnessCtx — the unified ctx passed to every handler
// ===========================================================================

export interface HarnessCtxDeps {
  db: FakeDb;
  storage: FakeStorage;
  scheduler: FakeScheduler;
  registry: Registry;
}

/**
 * The single ctx object the dispatcher hands to every resolved handler. It is
 * the same shape Convex queries / mutations / actions receive (the parts the
 * SUT touches): `db`, `storage.delete`, `scheduler`, and the run* dispatchers
 * that resolve a ref back through the Registry and recurse with this same ctx.
 */
export function buildHarnessCtx(deps: HarnessCtxDeps): unknown {
  const { db, storage, scheduler, registry } = deps;

  const run = async (ref: AnyFunctionReference, args: unknown): Promise<unknown> => {
    const handler = registry.resolve(ref);
    return await handler(ctx, args ?? {});
  };

  const ctx = {
    db,
    storage: {
      // Only the calls the SUT makes from an action: delete (fill) + getUrl is
      // never reached because ../storage.getStorageBytes is mocked to FakeStorage.
      delete: (storageId: string) => storage.delete(storageId),
    },
    scheduler: {
      runAfter: (delayMs: number, ref: AnyFunctionReference, args: unknown) =>
        scheduler.runAfter(delayMs, ref, args),
      runAt: (ts: number, ref: AnyFunctionReference, args: unknown) =>
        scheduler.runAt(ts, ref, args),
    },
    runQuery: run,
    runMutation: run,
    runAction: run,
  };
  return ctx;
}
