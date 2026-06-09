// Pure projection helpers for the Feishu Contacts Mirror (ADR-0023). Everything
// here is PURE — no ctx, no db, no I/O — so the field mapping, the searchable
// blob, and the dedupe can be unit-tested in isolation. The effectful sync loop
// lives in contactsMirror.ts and the pagination/prune state machine in
// contactsMirrorSync.ts.
//
// HARD constraints from the request:
//  - email is the ENTERPRISE mailbox (enterprise_email, the @fenchem.com one)
//    ONLY — the personal `email` field is never stored.
//  - phone numbers are never read or stored (no field for them exists below).
//  - avatar IS stored (volatile URL — see ADR-0003; the biweekly run re-stamps
//    it and any consumer must fall back to initials on a 404).

import { cjkBigramBlob } from "./cjkSearch";
import { buildPinyinKeys, foldName } from "./pinyinTokens";

// One Feishu directory user as returned by /contact/v3/users/find_by_department
// (open.feishu.cn). Only the fields the mirror reads are typed; phone fields are
// deliberately omitted so they can never be projected by accident.
export interface FeishuContactUser {
  open_id: string;
  name: string;
  // The @fenchem.com company mailbox. `email` (personal/registration) is
  // intentionally NOT in this type — it must never be stored.
  enterprise_email?: string;
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
  avatar_url?: string;
  // open_department_ids the user belongs to (we request
  // department_id_type=open_department_id so these match the department map).
  department_ids?: string[];
  status?: {
    is_frozen?: boolean;
    is_resigned?: boolean;
    is_activated?: boolean;
    is_exited?: boolean;
    is_unjoin?: boolean;
  };
}

// The slim row stored in / read back from the `feishuContacts` mirror table.
// Optional fields are `undefined` (not "") when absent so a consumer can tell
// "absent" from "blank", mirroring CustomerRecord (customers.ts).
export interface ContactUpsertRow {
  openId: string;
  name: string;
  email?: string;
  department?: string;
  departmentIds?: string[];
  avatarUrl?: string;
  searchBlob: string;
  // ADR-0024: Pinyin match keys (sync-time precomputed; omitted when the name
  // has no Han characters). nameFold is always set for a non-empty name.
  pinyinFull?: string;
  pinyinInitials?: string;
  pinyinAlts?: string;
  nameFold?: string;
}

// Slim row the colleague picker preloads (ADR-0024). Includes avatarUrl so the
// search dropdown shows real photos; the URL is volatile (ADR-0003) so the
// consumer must fall back to initials/icon on a 404. Pinyin fields default to ""
// client-side.
export interface ContactPickerRow {
  openId: string;
  name: string;
  email?: string;
  department?: string;
  avatarUrl?: string;
  pinyinFull: string;
  pinyinInitials: string;
  pinyinAlts: string;
  nameFold: string;
}

export interface ContactMirrorDoc {
  openId: string;
  name: string;
  email?: string;
  department?: string;
  avatarUrl?: string;
}

export interface ContactRecord {
  openId: string;
  name: string;
  email?: string;
  department?: string;
  avatarUrl?: string;
}

// Avatar URL fallback chain — mirrors coworkers.ts `coworkerAvatarUrl` (ADR-0003:
// some tenant responses omit avatar_72 but carry a larger size). Inlined rather
// than imported so this module stays pure (no _generated/server pull-in) and the
// sync stays orthogonal to the coworker-search code.
export function feishuAvatarUrl(user: FeishuContactUser): string | undefined {
  return (
    user.avatar?.avatar_72 ??
    user.avatar?.avatar_240 ??
    user.avatar?.avatar_640 ??
    user.avatar?.avatar_origin ??
    user.avatar_url
  );
}

// Trim a Feishu string field; return `undefined` for absent/blank so the
// projection surfaces "absent" instead of "".
function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Resolve a user's open_department_ids to their names via the crawl-built map,
// joined with " / ". Unknown ids (department not in the map) are dropped;
// returns `undefined` when nothing resolves.
export function joinDepartmentNames(
  departmentIds: readonly string[] | undefined,
  departmentNameById: ReadonlyMap<string, string>,
): string | undefined {
  if (!departmentIds || departmentIds.length === 0) return undefined;
  const names = departmentIds
    .map((id) => departmentNameById.get(id))
    .filter((name): name is string => name !== undefined);
  return names.length > 0 ? names.join(" / ") : undefined;
}

// Build the single searchable text column. Convex's search index ranks tokens
// across one column; concatenating name + enterprise email + department gives
// "type anything that identifies the colleague" behavior. Per-field CJK
// character bigrams are appended so substring/cross-punctuation queries over
// Chinese names also match (see cjkSearch.ts), exactly as buildSearchBlob does
// for customers.
export function buildContactSearchBlob(contact: {
  name: string;
  email?: string;
  department?: string;
}): string {
  const fields = [contact.name, contact.email ?? "", contact.department ?? ""].filter(Boolean);
  const base = fields.join(" ");
  const bigrams = fields
    .flatMap((field) => {
      const blob = cjkBigramBlob(field);
      return blob ? [blob] : [];
    })
    .join(" ");
  return bigrams ? `${base} ${bigrams}` : base;
}

// Map one Feishu directory user to the stored row. `email` is enterprise_email
// only; `department` is the joined department name(s).
export function mapUserToRow(
  user: FeishuContactUser,
  departmentNameById: ReadonlyMap<string, string>,
): ContactUpsertRow {
  const email = normalizeOptional(user.enterprise_email);
  const department = joinDepartmentNames(user.department_ids, departmentNameById);
  const departmentIds =
    user.department_ids && user.department_ids.length > 0 ? user.department_ids : undefined;
  const name = user.name;
  const pinyin = buildPinyinKeys(name);
  return {
    openId: user.open_id,
    name,
    email,
    department,
    departmentIds,
    avatarUrl: feishuAvatarUrl(user),
    searchBlob: buildContactSearchBlob({ name, email, department }),
    // ADR-0024: precompute Pinyin keys for the picker's client matcher. Empty
    // strings (no Han) become `undefined` so the optional column stays absent.
    pinyinFull: pinyin.full || undefined,
    pinyinInitials: pinyin.initials || undefined,
    pinyinAlts: pinyin.alts || undefined,
    nameFold: foldName(name),
  };
}

// Last-write-wins dedupe by openId (a user appears once per direct department
// during the crawl; find_by_department returns the user's full department_ids
// each time, so keeping any single occurrence preserves all memberships).
export function dedupeRowsByOpenId(rows: readonly ContactUpsertRow[]): ContactUpsertRow[] {
  return [...new Map(rows.map((row) => [row.openId, row])).values()];
}

export function mirrorDocToContact(doc: ContactMirrorDoc): ContactRecord {
  return {
    openId: doc.openId,
    name: doc.name,
    email: doc.email,
    department: doc.department,
    avatarUrl: doc.avatarUrl,
  };
}
