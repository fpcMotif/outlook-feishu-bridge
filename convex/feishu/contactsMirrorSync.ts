// Pure pagination / crawl helpers for the Feishu Contacts Mirror biweekly
// sync (ADR-0023). Everything here is PURE — no ctx, no db, no I/O — so the
// page-to-page advance, the resigned filter, the dedupe, the multi-walk
// completeness fold, and the prune accounting are unit-testable in isolation.
// The effectful fetch/apply loop lives in contactsMirror.ts, and the lifecycle
// sequencing (completeness gate → gated write → prune gate → finish) lives in
// the shared Mirror Refresh engine (mirrorRefresh.ts). Sibling of
// customerMirrorSync.ts.
//
// Completeness differs from the Customer Table mirror: the directory has NO
// global `total` and NO "list all users" endpoint (open.feishu.cn). The org is
// enumerated by crawling departments (departments/:id/children?fetch_child=true)
// then listing each department's DIRECT members (users/find_by_department).
// A run is "complete" only when the department-list walk AND every per-department
// member walk reached has_more=false with no missing / duplicate page_token.

import type { FeishuContactUser } from "./contactsMirrorRows";

export { pageSlotWaitMs } from "./mirrorRefresh";

// stopReasonForPage never returns "incomplete"; it is reserved for a future
// abnormal stop and kept in the union so the schema/state row stays forward-
// compatible. Today a broken walk surfaces its specific reason verbatim.
export type ContactStopReason =
  | "complete"
  | "missingPageToken"
  | "duplicatePageToken"
  | "incomplete";

// The pagination fields every Feishu list response carries.
export interface PageEnvelope {
  has_more?: boolean;
  page_token?: string;
}

// One department as returned by /contact/v3/departments/:id/children.
export interface FeishuDepartment {
  department_id?: string;
  open_department_id?: string;
  name?: string;
  parent_department_id?: string;
}

export function stopReasonForPage(
  data: PageEnvelope,
  seenPageTokens: Set<string>,
): Exclude<ContactStopReason, "incomplete"> | null {
  if (data.has_more !== true) return "complete";
  if (!data.page_token) return "missingPageToken";
  if (seenPageTokens.has(data.page_token)) return "duplicatePageToken";
  return null;
}

// Decide whether to keep paging. On a continue, the next page_token is recorded
// in seenPageTokens (loop-detection) and returned; otherwise a stop reason is.
export function nextPageTokenOrStop(
  data: PageEnvelope,
  seenPageTokens: Set<string>,
  pageNumber: number,
  label: string,
): { pageToken?: string; stopReason?: ContactStopReason } {
  const stopReason = stopReasonForPage(data, seenPageTokens);
  if (stopReason === "complete") return { stopReason };
  if (stopReason !== null) {
    console.error(`[contacts-mirror] ${label} stopped early: reason=${stopReason} after page=${pageNumber}`);
    return { stopReason };
  }
  const nextPageToken = data.page_token;
  if (!nextPageToken) return { stopReason: "missingPageToken" };
  seenPageTokens.add(nextPageToken);
  return { pageToken: nextPageToken };
}

// --- Department map ---------------------------------------------------------

// Prefer open_department_id (matches user.department_ids when we request
// department_id_type=open_department_id); fall back to the custom department_id.
export function departmentKey(dept: FeishuDepartment): string | null {
  return dept.open_department_id ?? dept.department_id ?? null;
}

// Fold one page of departments into the id→name map (in place).
export function addDepartmentsToNameMap(
  map: Map<string, string>,
  departments: readonly FeishuDepartment[],
): void {
  for (const dept of departments) {
    const key = departmentKey(dept);
    if (key && typeof dept.name === "string" && dept.name !== "") {
      map.set(key, dept.name);
    }
  }
}

// --- Active / resigned filter ----------------------------------------------

// Active = not resigned and not exited. Frozen (suspended) accounts are kept —
// the request was to skip resigned & exited only.
export function isActiveContact(user: Pick<FeishuContactUser, "status">): boolean {
  const status = user.status;
  if (!status) return true;
  return !(status.is_resigned === true || status.is_exited === true);
}

export function partitionActive<T extends Pick<FeishuContactUser, "status">>(
  users: readonly T[],
): { active: T[]; skippedResigned: number } {
  const active = users.filter((user) => isActiveContact(user));
  return { active, skippedResigned: users.length - active.length };
}

// Last-write-wins dedupe by open_id across the multi-department crawl.
export function dedupeUsersByOpenId<T extends Pick<FeishuContactUser, "open_id">>(
  users: readonly T[],
): T[] {
  return [...new Map(users.map((user) => [user.open_id, user])).values()];
}

// --- Completeness fold ------------------------------------------------------

// The run is only as complete as its weakest walk: the first non-"complete"
// reason (department crawl or any member walk) wins; otherwise "complete".
export function worstStopReason(reasons: readonly ContactStopReason[]): ContactStopReason {
  for (const reason of reasons) {
    if (reason !== "complete") return reason;
  }
  return "complete";
}

// The biweekly assumption: the directory is ≤ 800 entries. A breach is logged
// loudly (the paging/cost assumptions should be revisited) but never fails the
// run — the crawl still pages until has_more=false.
export const ASSUMED_MAX_CONTACTS = 800;

export function exceedsAssumedMax(userCount: number, max: number = ASSUMED_MAX_CONTACTS): boolean {
  return userCount > max;
}

// --- Mirror Prune (tombstone) ----------------------------------------------
// Same hazard + gate as the Customer mirror (ADR-0021): the mirror upserts keyed
// by openId but never deletes, so an employee who LEFT (resigned/exited, now
// filtered out) would otherwise linger forever. The prune deletes any mirror row
// whose openId was NOT observed during a *complete* crawl. open_id is stable, so
// in steady state the prune removes exactly the leavers.

export interface PrunableContactRow<TId> {
  _id: TId;
  openId: string;
}

export interface PruneTotals {
  scanned: number;
  deleted: number;
}

export function emptyPruneTotals(): PruneTotals {
  return { scanned: 0, deleted: 0 };
}

// Ids of mirror rows whose openId was not seen in THIS sync — orphans to
// tombstone. Pure.
export function staleContactIds<TId>(
  rows: readonly PrunableContactRow<TId>[],
  seenOpenIds: ReadonlySet<string>,
): TId[] {
  const ids: TId[] = [];
  for (const row of rows) {
    if (!seenOpenIds.has(row.openId)) ids.push(row._id);
  }
  return ids;
}

export function addPrunePage<TId>(
  totals: PruneTotals,
  scannedRows: readonly PrunableContactRow<TId>[],
  deletedIds: readonly TId[],
): void {
  totals.scanned += scannedRows.length;
  totals.deleted += deletedIds.length;
}

// The lifecycle sequencing that used to live here (crawl → completeness gate →
// write → prune gate → finish) is now the shared Mirror Refresh engine in
// mirrorRefresh.ts, driven by the adapter in contactsMirror.ts. This file keeps
// only the contacts-specific crawl/prune helpers.
