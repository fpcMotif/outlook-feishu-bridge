import { describe, expect, it } from "vitest";

import { buildBitableRecordDetailUrl } from "./bitableUrl";

describe("buildBitableRecordDetailUrl", () => {
  it("builds a Feishu Base record link from configured app, table, and record ids", () => {
    expect(
      buildBitableRecordDetailUrl({
        appToken: "app_token",
        tableId: "tbl_service",
        recordId: "rec_service",
      }),
    ).toBe("https://feishu.cn/base/app_token?table=tbl_service&record=rec_service");
  });

  it("adds the app token to a custom Base URL when the path does not include it", () => {
    expect(
      buildBitableRecordDetailUrl({
        baseUrl: "https://example.com/base",
        appToken: "app_token",
        tableId: "tbl_service",
        recordId: "rec_service",
      }),
    ).toBe("https://example.com/base/app_token?table=tbl_service&record=rec_service");
  });

  it("returns null when any required id is missing", () => {
    expect(
      buildBitableRecordDetailUrl({
        appToken: "app_token",
        tableId: "tbl_service",
        recordId: " ",
      }),
    ).toBeNull();
  });
});
