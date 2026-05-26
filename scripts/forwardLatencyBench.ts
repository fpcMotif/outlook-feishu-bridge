// Synthetic latency benchmark for the Outlook -> Feishu forward pipeline.
//
// It drives the REAL `forwardEmail` client orchestration (src/forward/forwardEmail.ts)
// with fake Office/Convex/Feishu deps whose delays follow a documented
// China-taskpane -> US-Convex -> Feishu network model (see DELAY below). It measures
// wall-clock T_total for the goal's Case A and Case B, so the effect of
// parallelizing the orchestration is visible WITHOUT a live Outlook + Feishu run.
//
// Attachment "bytes" are modeled purely as delays (we do NOT allocate real MB-sized
// buffers) so wall-clock reflects orchestration I/O overlap, not base64 CPU.
//
// This is a DIRECTIONAL tool, not delivery proof: the model numbers are estimates.
// Real proof comes from the on-screen DebugPanel dlog() timings + `npx convex logs`
// during an actual forward (the app is instrumented for exactly that). Run with:
//   bun scripts/forwardLatencyBench.ts

import { forwardEmail, type ForwardDeps } from "../src/forward/forwardEmail";
import type { MailItemData, AttachmentInfo } from "../src/office/useMailItem";
import type { ForwardTargets } from "../src/forward/targets";

const mb = (bytes: number) => bytes / (1024 * 1024);

// --- Virtual clock: deterministic, load-independent timing ---
// Real setTimeout is unreliable on a busy machine, so we model time logically.
// `sleep` registers a wakeup on a virtual clock; `runVirtual` drains microtasks
// (real continuations) then advances the clock to the next due wakeup. Concurrent
// sleeps (Promise.all) share the advancing clock, so elapsed == critical path.
let vnow = 0;
let timers: { at: number; resolve: () => void }[] = [];
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    timers.push({ at: vnow + ms, resolve });
  });
const flush = () => new Promise<void>((r) => setImmediate(r));

async function runVirtual<T>(task: () => Promise<T>): Promise<number> {
  vnow = 0;
  timers = [];
  let done = false;
  void task().then(() => {
    done = true;
  });
  while (!done) {
    await flush(); // run continuations scheduled at the current virtual time
    if (done) break;
    if (timers.length === 0) {
      await flush();
      if (timers.length === 0) break; // nothing left to advance to
    }
    timers.sort((a, b) => a.at - b.at);
    vnow = timers[0].at;
    const due = timers.filter((t) => t.at <= vnow);
    timers = timers.filter((t) => t.at > vnow);
    for (const t of due) t.resolve();
  }
  return vnow;
}

// --- Network delay model (ms). China taskpane -> US Convex -> Feishu. Estimates. ---
const DELAY = {
  officeRead: (bytes: number) => 100 + mb(bytes) * 100, // getAttachmentContentAsync
  uploadUrlRtt: 180, // generateUploadUrl mutation RTT (CN->US)
  stage: (bytes: number) => 120 + mb(bytes) * 260, // POST bytes to Convex storage (CN uplink)
  feishuUpload: (bytes: number) => 230 + mb(bytes) * 180, // upload action: read storage + push to Feishu
  pdfGen: 120, // text-only vector PDF gen feed (Office body read)
  pdfUpload: 280,
  markdownGen: 180,
  docBase: 600, // createDoc: create document + insert blocks
  docPerMedia: (bytes: number) => 900 + mb(bytes) * 180, // block + storage read + drive upload + patch
  // forwardToFeishu server time. SERVER_SEQ=1 models the pre-change sequential
  // follow-ups (token + card + N*send); default models concurrent follow-ups
  // dispatched after the card (token + card + one parallel batch).
  serverSend: (followUps: number) =>
    process.env.SERVER_SEQ === "1"
      ? 150 + 250 + followUps * 250
      : 150 + 250 + (followUps > 0 ? 250 : 0),
  applyCategory: 200,
};

const SIZE = { image: 200 * 1024, file: 5 * 1024 * 1024 };

const sizeById: Record<string, number> = { img1: SIZE.image, f1: SIZE.file };
const sizeByName = new Map<string, number>([
  ["logo.png", SIZE.image],
  ["report.bin", SIZE.file],
]);

// Stage POST stub: product code calls fetch(uploadUrl, { body: blob }). The bytes
// are modeled (not allocated), so just return a fake storageId immediately.
let seq = 0;
globalThis.fetch = (async () =>
  ({ json: async () => ({ storageId: `storage_${seq++}` }) }) as Response) as unknown as typeof fetch;

type Segments = Record<string, number>;

function makeDeps(seg: Segments): ForwardDeps {
  const add = (k: string, ms: number) => {
    seg[k] = (seg[k] ?? 0) + ms;
  };
  const stageUpload = async (bytes: number) => {
    const s = DELAY.stage(bytes);
    add("stage", s);
    await sleep(s);
    const u = DELAY.feishuUpload(bytes);
    add("feishuUpload", u);
    await sleep(u);
  };
  return {
    getAttachmentContent: async (id: string) => {
      const ms = DELAY.officeRead(sizeById[id] ?? 0);
      add("officeRead", ms);
      await sleep(ms);
      return { format: "base64", content: "" };
    },
    generateUploadUrl: async () => {
      add("uploadUrl", DELAY.uploadUrlRtt);
      await sleep(DELAY.uploadUrlRtt);
      return `https://upload/${seq}`;
    },
    uploadAttachment: async ({ fileName }) => {
      await stageUpload(sizeByName.get(fileName) ?? 0);
      return { fileKey: "FK" };
    },
    uploadImage: async ({ fileName }) => {
      await stageUpload(sizeByName.get(fileName) ?? 0);
      return { imageKey: "IK" };
    },
    createDoc: async ({ imageStorageIds, fileStorageIds }) => {
      let ms = DELAY.docBase;
      for (const _ of imageStorageIds ?? []) ms += DELAY.docPerMedia(SIZE.image);
      for (const _ of fileStorageIds ?? []) ms += DELAY.docPerMedia(SIZE.file);
      add("docCreate", ms);
      await sleep(ms);
      return { docUrl: "https://feishu.cn/docx/X", docToken: "X" };
    },
    forwardToFeishu: async (args) => {
      // The forward action uploads the PDF server-side (collapsed round-trip),
      // then sends the card + follow-ups.
      const hasPdf = Boolean(args.pdfBytes || args.pdfStorageId);
      if (hasPdf) {
        add("pdfUpload", DELAY.pdfUpload);
        await sleep(DELAY.pdfUpload);
      }
      const followUps = (hasPdf ? 1 : 0) + (args.attachmentFileKeys?.length ?? 0);
      const ms = DELAY.serverSend(followUps);
      add("serverSend", ms);
      await sleep(ms);
      return {};
    },
    generatePdf: async () => {
      add("pdfGen", DELAY.pdfGen);
      await sleep(DELAY.pdfGen);
      return new ArrayBuffer(65 * 1024);
    },
    generateMarkdown: async () => {
      add("markdownGen", DELAY.markdownGen);
      await sleep(DELAY.markdownGen);
      return "# md";
    },
    applyFeishuCategory: async () => {
      add("applyCategory", DELAY.applyCategory);
      await sleep(DELAY.applyCategory);
      return true;
    },
    onProgress: () => {},
  };
}

function mailItem(attachments: AttachmentInfo[]): MailItemData {
  return {
    subject: "Quarterly update",
    from: "a@x.com",
    to: ["b@x.com"],
    cc: [],
    body: "Body text ".repeat(50),
    dateTimeCreated: new Date(0),
    internetMessageId: "<id>",
    itemId: "item1",
    conversationId: "conv1",
    userEmail: "me@x.com",
    attachments,
  };
}

const ATTACHMENTS: AttachmentInfo[] = [
  { id: "img1", name: "logo.png", contentType: "image/png", size: SIZE.image, isInline: true },
  { id: "f1", name: "report.bin", contentType: "application/octet-stream", size: SIZE.file, isInline: false },
];

function targets(o: Partial<ForwardTargets>): ForwardTargets {
  return {
    bot: false, chat: true, bitable: false,
    attachPdf: true, includeAttachments: false, createDoc: false,
    contacts: [], groups: [], ...o,
  };
}

async function measure(name: string, item: MailItemData, t: ForwardTargets) {
  const seg: Segments = {};
  const deps = makeDeps(seg);
  const ms = Math.round(await runVirtual(() => forwardEmail(deps, item, t, "sess")));
  console.log(`METRIC ${name}=${ms}`);
  return { ms, seg };
}

async function main() {
  const specs: [string, MailItemData, ForwardTargets][] = [
    ["caseA_ms", mailItem([]), targets({})],
    ["caseB_no_doc_ms", mailItem(ATTACHMENTS), targets({ includeAttachments: true })],
    ["caseB_doc_ms", mailItem(ATTACHMENTS), targets({ includeAttachments: true, createDoc: true })],
  ];
  console.log(`server model: ${process.env.SERVER_SEQ === "1" ? "sequential follow-ups (baseline)" : "concurrent follow-ups"}`);
  const rows: { name: string; serial: number; ms: number; seg: Segments }[] = [];
  for (const [name, item, t] of specs) {
    const { ms, seg } = await measure(name, item, t);
    rows.push({ name, serial: Math.round(Object.values(seg).reduce((a, b) => a + b, 0)), ms, seg });
  }

  // "sequential" = serial sum of modeled segments (== wall-clock of the old
  // serial pipeline). "concurrent" = critical path measured against the current
  // code. Equal only when nothing overlaps (Case A).
  console.log("\ncase             sequential   concurrent   reduction");
  for (const r of rows) {
    const pct = r.serial > 0 ? ((1 - r.ms / r.serial) * 100).toFixed(0) : "0";
    console.log(`${r.name.padEnd(16)} ${String(r.serial).padStart(8)}ms ${String(r.ms).padStart(9)}ms ${pct.padStart(8)}%`);
  }

  const doc = rows[rows.length - 1];
  console.log(`\nCase B (+doc) segment model (sequential ${doc.serial}ms -> concurrent ${doc.ms}ms):`);
  for (const [k, v] of Object.entries(doc.seg).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${String(Math.round(v)).padStart(6)}ms  ${((v / doc.serial) * 100).toFixed(1)}%`);
  }
}

void main();
