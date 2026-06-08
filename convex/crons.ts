// Convex cron jobs. Per Convex AI guidelines: only `crons.interval` /
// `crons.cron` (not the dropped hourly/daily/weekly helpers), and the called
// function is passed by FunctionReference (`internal.<file>.<fn>`).
//
// Scheduled work is INTENTIONALLY limited to the two directory dual-syncs:
// the Customer Mirror (weekly, ADR-0016) and the Feishu Contacts Mirror
// (biweekly, ADR-0023). Everything else is on-demand:
//   - Request→Bitable outbox retry is a per-task bounded self-scheduling chain
//     (max 5 attempts, see feishu/requestSync.ts), NOT a periodic sweep. The
//     rare stranded row self-heals when the taskpane reopens that conversation
//     (emails.ts getBitableSyncByConversation `rearmable`); reconcilePending-
//     BitableSync remains runnable via `bunx convex run` as a manual backstop.
//   - coworkerSearchCache TTL is enforced lazily on read; no cleanup cron.
// Keep this file the single registry — do not add a cron without a clear reason.

import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// Weekly Customer Mirror refresh (ADR-0016). The Customer Table is a slow-
// moving CRM directory; weekly is enough background freshness for the
// server-indexed search path. Faster refresh comes from the on-demand kick
// that fires whenever the salesperson opens the customer search panel — so
// any time someone actually cares about freshness, they trigger a sync
// themselves. 7 days × 24 h = 168 hours.
crons.interval(
  "customers mirror refresh (weekly)",
  { hours: 168 },
  internal.feishu.customersMirror.fullSync,
  {},
);

// Biweekly Feishu Contacts (org directory) mirror refresh (ADR-0023). The
// directory is slow-moving, so every two weeks is enough background freshness
// for the server-indexed colleague search. 14 days × 24 h = 336 hours.
crons.interval(
  "feishu contacts mirror refresh (biweekly)",
  { hours: 336 },
  internal.feishu.contactsMirror.fullSync,
  {},
);

export default crons;
