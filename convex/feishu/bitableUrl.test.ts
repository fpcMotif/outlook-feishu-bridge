import { describe, expect, it } from "vitest";

import { buildBitableRecordDetailUrl } from "./bitableUrl";

describe("buildBitableRecordDetailUrl", () => {
  it("builds a Feishu Base record detail URL from app, table, and record ids", () => {
    expect(
      buildBitableRecordDetailUrl({
        appToken: "appToken123",
        tableId: "tbl_service",
        recordId: "rec_service_1",
      }),
    ).toBe("https://feishu.cn/base/appToken123?table=tbl_service&record=rec_service_1");
  });

  it("allows a tenant-specific Base URL while preserving table and record params", () => {
    expect(
      buildBitableRecordDetailUrl({
        baseUrl: "https://example.feishu.cn/base/appToken123?table=old",
        appToken: "appToken123",
        tableId: "tbl_service",
        recordId: "rec_service_1",
      }),
    ).toBe("https://example.feishu.cn/base/appToken123?table=tbl_service&record=rec_service_1");
  });

  it("returns null until all URL ids are available", () => {
    expect(
      buildBitableRecordDetailUrl({
        appToken: "appToken123",
        tableId: "",
        recordId: "rec_service_1",
      }),
    ).toBeNull();
  });
});
