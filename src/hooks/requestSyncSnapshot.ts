const REQUEST_SYNC_SNAPSHOT_KEY = "feishu_request_sync_snapshots";
const REQUEST_SYNC_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_SYNC_SNAPSHOT_MAX_ENTRIES = 90;

interface RequestSyncIdentity {
  userEmail?: string;
  conversationId?: string;
  internetMessageId?: string;
}

export interface SyncedRequestSnapshot {
  status: "synced";
  recordId: string;
  detailUrl: string | null;
  coworkerCount?: number;
  syncedAt?: number;
  error: null;
}

interface StoredSyncedRequestSnapshot {
  recordId: string;
  detailUrl: string | null;
  coworkerCount?: number;
  syncedAt: number;
  savedAt: number;
  expiresAt: number;
}

function requestSyncSnapshotKeys(identity: RequestSyncIdentity): string[] {
  const userEmail = identity.userEmail?.trim().toLowerCase();
  const conversationId = identity.conversationId?.trim();
  const internetMessageId = identity.internetMessageId?.trim();
  if (!userEmail) return [];
  const keys: string[] = [];
  if (conversationId) {
    keys.push(`conversation:${userEmail}\n${conversationId}`);
    keys.push(`${userEmail}\n${conversationId}`);
  }
  if (internetMessageId) keys.push(`message:${userEmail}\n${internetMessageId}`);
  return keys;
}

function readSnapshotMap(): Record<string, StoredSyncedRequestSnapshot> {
  try {
    const raw = localStorage.getItem(REQUEST_SYNC_SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, StoredSyncedRequestSnapshot>
      : {};
  } catch {
    return {};
  }
}

function writeSnapshotMap(map: Record<string, StoredSyncedRequestSnapshot>): void {
  localStorage.setItem(REQUEST_SYNC_SNAPSHOT_KEY, JSON.stringify(map));
}

function pruneSnapshotMap(
  map: Record<string, StoredSyncedRequestSnapshot>,
  now: number,
): Record<string, StoredSyncedRequestSnapshot> {
  const entries = Object.entries(map)
    .filter(([, snapshot]) => snapshot.expiresAt > now)
    .toSorted(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, REQUEST_SYNC_SNAPSHOT_MAX_ENTRIES);
  return Object.fromEntries(entries);
}

export function readRequestSyncSnapshot(
  identity: RequestSyncIdentity,
  now = Date.now(),
): SyncedRequestSnapshot | null {
  const map = readSnapshotMap();
  const snapshot = requestSyncSnapshotKeys(identity)
    .map((key) => map[key])
    .find((candidate) => candidate && candidate.expiresAt > now && candidate.recordId);
  if (!snapshot || snapshot.expiresAt <= now || !snapshot.recordId) return null;
  return {
    status: "synced",
    recordId: snapshot.recordId,
    detailUrl: snapshot.detailUrl ?? null,
    coworkerCount: snapshot.coworkerCount,
    syncedAt: snapshot.syncedAt,
    error: null,
  };
}

export function rememberRequestSyncSnapshot(
  identity: RequestSyncIdentity,
  sync: {
    recordId?: string | null;
    detailUrl?: string | null;
    coworkerCount?: number;
    syncedAt?: number;
  },
  now = Date.now(),
): void {
  const keys = requestSyncSnapshotKeys(identity);
  if (keys.length === 0 || !sync.recordId) return;
  const map = pruneSnapshotMap(readSnapshotMap(), now);
  const snapshot = {
    recordId: sync.recordId,
    detailUrl: sync.detailUrl ?? null,
    coworkerCount: sync.coworkerCount,
    syncedAt: sync.syncedAt ?? now,
    savedAt: now,
    expiresAt: now + REQUEST_SYNC_SNAPSHOT_TTL_MS,
  };
  for (const key of keys) map[key] = snapshot;
  writeSnapshotMap(pruneSnapshotMap(map, now));
}

export function clearRequestSyncSnapshot(identity: RequestSyncIdentity): void {
  const keys = requestSyncSnapshotKeys(identity);
  if (keys.length === 0) return;
  const map = readSnapshotMap();
  for (const key of keys) delete map[key];
  writeSnapshotMap(map);
}
