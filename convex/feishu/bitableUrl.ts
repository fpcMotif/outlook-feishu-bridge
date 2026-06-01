const DEFAULT_BASE_URL = "https://feishu.cn/base";

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function buildBitableRecordDetailUrl({
  baseUrl,
  appToken,
  tableId,
  recordId,
}: {
  baseUrl?: string;
  appToken: string | undefined;
  tableId: string | undefined;
  recordId: string | undefined;
}): string | null {
  const app = trimmed(appToken);
  const table = trimmed(tableId);
  const record = trimmed(recordId);
  if (!app || !table || !record) return null;

  const url = new URL(trimmed(baseUrl) || `${DEFAULT_BASE_URL}/${encodeURIComponent(app)}`);
  const pathSegments = url.pathname.split("/").filter(Boolean);
  if (!pathSegments.includes(app)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(app)}`;
  }
  url.searchParams.set("table", table);
  url.searchParams.set("record", record);
  return url.toString();
}

export function buildConfiguredBitableRecordDetailUrl(recordId: string | undefined): string | null {
  return buildBitableRecordDetailUrl({
    baseUrl: process.env.FEISHU_BITABLE_WEB_BASE_URL,
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN,
    tableId: process.env.FEISHU_BITABLE_TABLE_ID,
    recordId,
  });
}
