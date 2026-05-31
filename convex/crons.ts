// Convex cron jobs. Per Convex AI guidelines: only `crons.interval` /
// `crons.cron` (not the dropped hourly/daily/weekly helpers), and the called
// function is passed by FunctionReference (`internal.<file>.<fn>`).
//
// Today: only the Customer Mirror refresh (ADR-0016). Add other crons here as
// they appear — keep this file the single registry.

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

crons.interval(
  "coworker search cache cleanup",
  { hours: 6 },
  internal.feishu.coworkers.cleanupExpiredCoworkerSearchCache,
  {},
);

export default crons;
