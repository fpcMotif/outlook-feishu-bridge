/* eslint-disable max-lines, max-lines-per-function, no-inline-comments, unicorn/consistent-function-scoping, unicorn/prefer-at -- test-support harness: a cohesive in-memory Feishu Base/Drive simulator. */
// In-memory Feishu Base + Drive simulation for the deferred Attachment Fill
// suite (ADR-0027). This is the stand-in for `callFeishu(ctx, opts)`: it routes
// by `opts.path` + `opts.method`, returns the SAME inner `data` payload shape
// the real callFeishu yields (callFeishu unwraps `parsed.data`, so the sim
// returns `{record:{record_id}}`, `{file_token}`, `{items}` directly — NOT
// wrapped in `{data}`), and records every write so the suite can assert on
// coalescing, wrong-row, column-scope, idempotency, and double-mint.
//
// It also models the live faults the pipeline must survive: the Drive 5-QPS
// frequency limit (code 99991400) as a concurrency gate, per-file upload
// failures (skip vs defer), create / PUT failures, and a manual upload gate so a
// test can hold two concurrent fills mid-flight to exercise the double-mint
// race. Every fault is a discoverable knob (see the README).
//
// Pure TypeScript: NO `vitest` import.

import { FeishuError } from "../client";

// The drive rate-limit gateway code the SUT's withDriveRateLimitRetry recovers
// from (mirrors FEISHU_RATE_LIMIT_CODE in drive.ts).
export const RATE_LIMIT_CODE = 99991400;

// The Customer table the Client DuplexLink domain-search hits (bitable.ts).
export const CLIENT_TABLE_ID = "tbl4TE2GV472sKzp";

/** Shape of one callFeishu options object the sim receives. */
interface CallOpts {
  path: string;
  method?: string;
  json?: { fields?: Record<string, unknown> } & Record<string, unknown>;
  form?: FormData;
  query?: Record<string, string>;
  label?: string;
}

/** A recorded Bitable record-update PUT. */
export interface PutLogEntry {
  recordId: string;
  fields: Record<string, unknown>;
  fieldKeys: string[];
}

/** A recorded Bitable create. */
export interface CreateLogEntry {
  recordId: string;
  clientToken: string | null;
  fields: Record<string, unknown>;
  deduped: boolean;
}

/** A recorded Drive media upload. */
export interface UploadLogEntry {
  fileName: string;
  fileToken: string;
}

/** A simulated Base row. */
interface BaseRow {
  recordId: string;
  fields: Record<string, unknown>;
}

interface UploadFault {
  remaining: number;
  code: number;
}

interface DeferFault {
  remaining: number;
}

interface CreateFault {
  remaining: number;
  err: Error;
}

interface PutPredicateFault {
  predicate: (opts: CallOpts, fields: Record<string, unknown>) => boolean;
  err: Error;
  remaining: number;
}

/** A pending upload gate latch — uploads block on it until released. */
interface UploadGate {
  promise: Promise<void>;
  release: () => void;
}

export class FeishuBaseSim {
  // ---- created rows + write logs ---------------------------------------
  private readonly rows = new Map<string, BaseRow>();
  private readonly tokenToRecord = new Map<string, string>(); // client_token -> recordId
  private recordSeq = 0;
  private fileTokenSeq = 0;

  readonly createLog: CreateLogEntry[] = [];
  readonly putLog: PutLogEntry[] = [];
  readonly uploadLog: UploadLogEntry[] = [];

  // ---- 5-QPS model -----------------------------------------------------
  private inFlightUploads = 0;
  /** Highest concurrent upload count observed — assert the cap held. */
  uploadConcurrencyPeak = 0;
  /** Cap above which a concurrent upload trips 99991400 (Drive: 5 QPS). */
  private uploadConcurrencyCap = 5;

  // ---- fault knobs -----------------------------------------------------
  private createFault: CreateFault | null = null;
  private putOnceFault: Error | null = null;
  private readonly putPredicateFaults: PutPredicateFault[] = [];
  private clientSearchItems: { record_id: string; fields?: Record<string, unknown> }[] = [];
  private readonly uploadFaults = new Map<string, UploadFault>();
  private readonly deferFaults = new Map<string, DeferFault>();
  private rateLimitNext = 0;
  private gate: UploadGate | null = null;

  // =====================================================================
  // The callFeishu entry point (the mock target)
  // =====================================================================

  /**
   * Routes one simulated Feishu call. Mirrors callFeishu's return contract:
   * yields the inner `data` payload, or throws FeishuError on a simulated
   * fault. `ctx` is accepted (and ignored) to match the real signature.
   */
  callFeishu = async (_ctx: unknown, opts: CallOpts): Promise<unknown> => {
    const method = (opts.method ?? "POST").toUpperCase();

    if (opts.path.endsWith("/medias/upload_all") && method === "POST") {
      return await this.handleUpload(opts);
    }
    // Client-domain search on the Customer table.
    if (opts.path.includes(`/tables/${CLIENT_TABLE_ID}/records/search`) && method === "POST") {
      return { items: this.clientSearchItems };
    }
    // Any other search (diag) — empty by default.
    if (opts.path.endsWith("/records/search") && method === "POST") {
      return { items: [] };
    }
    // Service-row CREATE.
    if (opts.path.endsWith("/records") && method === "POST") {
      return this.handleCreate(opts);
    }
    // Service-row UPDATE (Sales-after-create patch AND the attachment-fill PUT).
    if (/\/records\/[^/]+$/.test(opts.path) && method === "PUT") {
      return this.handlePut(opts);
    }
    // GET record (diag) — return the row if known.
    if (/\/records\/[^/]+$/.test(opts.path) && method === "GET") {
      const recordId = recordIdFromPath(opts.path);
      const row = this.rows.get(recordId);
      return { record: row ? { record_id: recordId, fields: row.fields } : undefined };
    }
    throw new Error(`FeishuBaseSim: unrouted call ${method} ${opts.path}`);
  };

  // =====================================================================
  // CREATE
  // =====================================================================

  private handleCreate(opts: CallOpts): { record: { record_id: string } } {
    const clientToken = opts.query?.client_token ?? null;
    // Idempotency: same client_token returns the SAME row, no second create.
    if (clientToken && this.tokenToRecord.has(clientToken)) {
      const recordId = this.tokenToRecord.get(clientToken)!;
      this.createLog.push({
        recordId,
        clientToken,
        fields: { ...opts.json?.fields },
        deduped: true,
      });
      return { record: { record_id: recordId } };
    }

    if (this.createFault && this.createFault.remaining > 0) {
      this.createFault.remaining -= 1;
      const err = this.createFault.err;
      if (this.createFault.remaining === 0) this.createFault = null;
      throw err;
    }

    this.recordSeq += 1;
    const recordId = `rec_sim_${this.recordSeq}`;
    const fields = { ...opts.json?.fields };
    this.rows.set(recordId, { recordId, fields });
    if (clientToken) this.tokenToRecord.set(clientToken, recordId);
    this.createLog.push({ recordId, clientToken, fields: { ...fields }, deduped: false });
    return { record: { record_id: recordId } };
  }

  // =====================================================================
  // PUT (update)
  // =====================================================================

  private handlePut(opts: CallOpts): { record: { record_id: string } } {
    const recordId = recordIdFromPath(opts.path);
    const fields = opts.json?.fields ?? {};

    // One-shot PUT fault.
    if (this.putOnceFault) {
      const err = this.putOnceFault;
      this.putOnceFault = null;
      throw err;
    }
    // Predicate-matched PUT faults.
    for (const fault of this.putPredicateFaults) {
      if (fault.remaining > 0 && fault.predicate(opts, fields)) {
        fault.remaining -= 1;
        throw fault.err;
      }
    }

    const row = this.rows.get(recordId);
    if (!row) {
      throw new FeishuError(
        1254043,
        `record ${recordId} not found`,
        opts.label ?? "Bitable update",
      );
    }
    // MERGE the patched fields onto the row (last-write-wins per column).
    Object.assign(row.fields, fields);
    this.putLog.push({
      recordId,
      fields: { ...fields },
      fieldKeys: Object.keys(fields),
    });
    return { record: { record_id: recordId } };
  }

  // =====================================================================
  // Drive upload_all (mint)
  // =====================================================================

  private async handleUpload(opts: CallOpts): Promise<{ file_token: string }> {
    const fileName = String(opts.form?.get("file_name") ?? "");

    // Permanent / transient per-file faults (checked before the gate so a
    // failing file does not occupy a concurrency slot needlessly).
    const upFault = this.uploadFaults.get(fileName);
    if (upFault && upFault.remaining > 0) {
      upFault.remaining -= 1;
      throw new FeishuError(
        upFault.code,
        `simulated upload failure for ${fileName}`,
        "Feishu Drive media upload_all",
      );
    }
    const defFault = this.deferFaults.get(fileName);
    if (defFault && defFault.remaining > 0) {
      defFault.remaining -= 1;
      // A generic (non-rate-limit) error => mintOneStagedSource classifies it
      // as `deferred` (withDriveRateLimitRetry rethrows non-99991400 at once).
      throw new Error(`simulated transient Drive failure for ${fileName}`);
    }
    // Programmed standalone rate-limit storm (recoverable by the retry wrapper).
    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1;
      throw new FeishuError(RATE_LIMIT_CODE, "request trigger frequency limit", "Feishu Drive media upload_all");
    }

    // Enter the concurrency window, then YIELD a microtask so the other uploads
    // dispatched in the same `Promise.all` wave also enter before any of us
    // checks the cap. Without this yield each upload would run to completion
    // synchronously and `uploadConcurrencyPeak` would always read 1, hiding the
    // true wave width the SUT drove (and never tripping the 5-QPS model).
    this.inFlightUploads += 1;
    this.uploadConcurrencyPeak = Math.max(this.uploadConcurrencyPeak, this.inFlightUploads);
    try {
      await Promise.resolve();
      this.uploadConcurrencyPeak = Math.max(this.uploadConcurrencyPeak, this.inFlightUploads);

      // 5-QPS model: too many concurrent uploads trips the gateway limit.
      if (this.inFlightUploads > this.uploadConcurrencyCap) {
        throw new FeishuError(
          RATE_LIMIT_CODE,
          "request trigger frequency limit",
          "Feishu Drive media upload_all",
        );
      }
      // Manual gate: hold the upload mid-flight (for the double-mint race).
      if (this.gate) await this.gate.promise;

      this.fileTokenSeq += 1;
      const fileToken = `boxcn_sim_${this.fileTokenSeq}`;
      this.uploadLog.push({ fileName, fileToken });
      return { file_token: fileToken };
    } finally {
      this.inFlightUploads -= 1;
    }
  }

  // =====================================================================
  // Fault-injection knobs
  // =====================================================================

  /** Fail the next CREATE once with `err`, then succeed. */
  failCreateOnce(err: Error): this {
    this.createFault = { remaining: 1, err };
    return this;
  }

  /** Fail the next `n` CREATEs with `err`, then succeed. */
  failCreateNTimes(n: number, err: Error): this {
    this.createFault = { remaining: n, err };
    return this;
  }

  /** Fail the next PUT once with `err`, then succeed. */
  failPutOnce(err: Error): this {
    this.putOnceFault = err;
    return this;
  }

  /**
   * Fail every PUT matching `predicate` with `err`, up to `times` (default ∞).
   * The predicate sees the raw opts and the resolved `fields` object — useful to
   * target only the Sales-Files column, a specific recordId, etc.
   */
  failPutMatching(
    predicate: (opts: CallOpts, fields: Record<string, unknown>) => boolean,
    err: Error,
    times: number = Number.POSITIVE_INFINITY,
  ): this {
    this.putPredicateFaults.push({ predicate, err, remaining: times });
    return this;
  }

  /** Set the Customer-table domain-search result (default = [] => null Client). */
  setClientSearchResult(
    items: { record_id: string; fields?: Record<string, unknown> }[],
  ): this {
    this.clientSearchItems = items;
    return this;
  }

  /**
   * Make the upload of `fileName` fail `times` (default 1) with `code` (default
   * a generic non-rate-limit FeishuError, so mintOneStagedSource defers it). Use
   * a permanent-shaped code only when you want the retry wrapper to rethrow.
   */
  failUploadFor(fileName: string, opts: { times?: number; code?: number } = {}): this {
    this.uploadFaults.set(fileName, {
      remaining: opts.times ?? 1,
      code: opts.code ?? 1_061_004,
    });
    return this;
  }

  /**
   * Make the upload of `fileName` throw a transient (non-Feishu) error `times`
   * (default 1) so the fill classifies it as `deferred` (kept for retry).
   */
  deferUploadFor(fileName: string, opts: { times?: number } = {}): this {
    this.deferFaults.set(fileName, { remaining: opts.times ?? 1 });
    return this;
  }

  /**
   * Throw the 99991400 frequency-limit on the next `times` uploads (any file),
   * then succeed — to assert withDriveRateLimitRetry recovers transparently.
   */
  rateLimitNextUpload(times: number = 1): this {
    this.rateLimitNext = times;
    return this;
  }

  /** Override the concurrent-upload cap that trips 99991400 (default 5). */
  setUploadConcurrencyCap(cap: number): this {
    this.uploadConcurrencyCap = cap;
    return this;
  }

  /**
   * Hold ALL uploads mid-flight until the returned `release()` is called. Lets a
   * test start two concurrent fills, wait until both have read state + entered
   * upload, then release — exercising the double-mint race (detect via a single
   * fileName appearing twice in `uploadLog`).
   */
  gateUploads(): { release: () => void } {
    let unblock: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const gate: UploadGate = {
      promise,
      release: () => {
        // Drop the gate so uploads queued after release pass straight through,
        // then unblock everyone already waiting on this latch.
        if (this.gate === gate) this.gate = null;
        unblock();
      },
    };
    this.gate = gate;
    return { release: gate.release };
  }

  // =====================================================================
  // Assertions / accessors
  // =====================================================================

  /** The recordIds that have been created (in creation order). */
  recordIds(): string[] {
    return [...this.rows.keys()];
  }

  /** Raw fields of a created row (deep copy), or null if unknown. */
  rowFields(recordId: string): Record<string, unknown> | null {
    const row = this.rows.get(recordId);
    return row ? structuredClone(row.fields) : null;
  }

  /**
   * The file_tokens currently in the `Sales Files` Attachment cell of a row, in
   * cell order. Returns [] when the cell is unset. The cell shape is the Feishu
   * Attachment value [{ file_token }] the PUT builder writes.
   */
  salesFilesTokens(recordId: string): string[] {
    const row = this.rows.get(recordId);
    const cell = row?.fields["Sales Files"];
    if (!Array.isArray(cell)) return [];
    return cell.map((c: unknown) =>
      typeof c === "object" && c !== null ? String((c as { file_token?: unknown }).file_token) : String(c),
    );
  }

  /** How many distinct file_tokens were minted (size of the upload log). */
  mintedCount(): number {
    return this.uploadLog.length;
  }

  /** file_tokens minted for a given fileName (>1 ⇒ a double-mint bug). */
  mintedTokensFor(fileName: string): string[] {
    // eslint-disable-next-line react-doctor/js-combine-iterations -- test assertion helper over a tiny upload log; clarity over a single-pass micro-opt
    return this.uploadLog.filter((u) => u.fileName === fileName).map((u) => u.fileToken);
  }

  /** PUTs that wrote a particular recordId. */
  putsForRecord(recordId: string): PutLogEntry[] {
    return this.putLog.filter((p) => p.recordId === recordId);
  }

  /** PUTs that touched the `Sales Files` column. */
  salesFilesPuts(): PutLogEntry[] {
    return this.putLog.filter((p) => p.fieldKeys.includes("Sales Files"));
  }
}

function recordIdFromPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}
