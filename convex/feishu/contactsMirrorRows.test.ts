// Unit tests for the PURE Feishu Contacts Mirror projection helpers (ADR-0023).
// No ctx/db — field mapping, the searchable blob, and dedupe are exercised
// directly; the effectful crawl in contactsMirror.ts is covered by the live run.

import { describe, expect, it } from "vitest";

import {
  buildContactSearchBlob,
  dedupeRowsByOpenId,
  feishuAvatarUrl,
  joinDepartmentNames,
  mapUserToRow,
  mirrorDocToContact,
  type ContactUpsertRow,
  type FeishuContactUser,
} from "./contactsMirrorRows";

const DEPT_NAMES = new Map([
  ["od-sales", "Sales"],
  ["od-apac", "APAC"],
]);

describe("feishuAvatarUrl", () => {
  it("prefers avatar_72, then falls through larger sizes, then avatar_url", () => {
    expect(feishuAvatarUrl({ open_id: "o", name: "n", avatar: { avatar_72: "a72", avatar_240: "a240" } })).toBe(
      "a72",
    );
    expect(feishuAvatarUrl({ open_id: "o", name: "n", avatar: { avatar_640: "a640" } })).toBe("a640");
    expect(feishuAvatarUrl({ open_id: "o", name: "n", avatar: { avatar_origin: "orig" } })).toBe("orig");
    expect(feishuAvatarUrl({ open_id: "o", name: "n", avatar_url: "url" })).toBe("url");
  });

  it("returns undefined when no avatar field is present", () => {
    expect(feishuAvatarUrl({ open_id: "o", name: "n" })).toBeUndefined();
  });
});

describe("joinDepartmentNames", () => {
  it("resolves ids to names joined with ' / '", () => {
    expect(joinDepartmentNames(["od-sales", "od-apac"], DEPT_NAMES)).toBe("Sales / APAC");
  });

  it("drops ids that are not in the map", () => {
    expect(joinDepartmentNames(["od-sales", "od-unknown"], DEPT_NAMES)).toBe("Sales");
  });

  it("returns undefined for empty or all-unknown ids", () => {
    expect(joinDepartmentNames([], DEPT_NAMES)).toBeUndefined();
    expect(joinDepartmentNames(undefined, DEPT_NAMES)).toBeUndefined();
    expect(joinDepartmentNames(["od-unknown"], DEPT_NAMES)).toBeUndefined();
  });
});

describe("buildContactSearchBlob", () => {
  it("concatenates name + email + department for a Latin contact (no bigrams)", () => {
    expect(
      buildContactSearchBlob({ name: "John Doe", email: "john@fenchem.com", department: "Sales" }),
    ).toBe("John Doe john@fenchem.com Sales");
  });

  it("appends per-field CJK bigrams after the plain concatenation", () => {
    const blob = buildContactSearchBlob({ name: "张伟", department: "销售部" });
    expect(blob).toContain("张伟");
    expect(blob).toContain("销售");
    expect(blob).toContain("售部");
  });

  it("skips absent optional fields", () => {
    expect(buildContactSearchBlob({ name: "Solo" })).toBe("Solo");
  });
});

describe("mapUserToRow", () => {
  it("maps a full user, trims enterprise_email, joins departments, picks the avatar", () => {
    const user: FeishuContactUser = {
      open_id: "ou_1",
      name: "Jane",
      enterprise_email: "  jane@fenchem.com  ",
      avatar: { avatar_72: "a72" },
      department_ids: ["od-sales", "od-apac"],
      status: { is_activated: true },
    };
    const row = mapUserToRow(user, DEPT_NAMES);
    expect(row).toMatchObject({
      openId: "ou_1",
      name: "Jane",
      email: "jane@fenchem.com",
      department: "Sales / APAC",
      departmentIds: ["od-sales", "od-apac"],
      avatarUrl: "a72",
    });
    expect(row.searchBlob).toContain("jane@fenchem.com");
    expect(row.searchBlob).toContain("Sales / APAC");
  });

  it("leaves email/department/avatar undefined when the source omits them", () => {
    const row = mapUserToRow({ open_id: "ou_2", name: "NoMail", department_ids: [] }, DEPT_NAMES);
    expect(row.email).toBeUndefined();
    expect(row.department).toBeUndefined();
    expect(row.departmentIds).toBeUndefined();
    expect(row.avatarUrl).toBeUndefined();
    expect(row.searchBlob).toBe("NoMail");
  });

  it("treats a blank enterprise_email as absent", () => {
    const row = mapUserToRow({ open_id: "ou_3", name: "Blank", enterprise_email: "   " }, DEPT_NAMES);
    expect(row.email).toBeUndefined();
  });
});

describe("dedupeRowsByOpenId", () => {
  it("keeps the last row for a repeated openId", () => {
    const rows: ContactUpsertRow[] = [
      { openId: "ou_1", name: "Old", searchBlob: "Old" },
      { openId: "ou_2", name: "Keep", searchBlob: "Keep" },
      { openId: "ou_1", name: "New", searchBlob: "New" },
    ];
    const deduped = dedupeRowsByOpenId(rows);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((r) => r.openId === "ou_1")?.name).toBe("New");
  });
});

describe("mirrorDocToContact", () => {
  it("projects the stored doc to the slim record", () => {
    expect(
      mirrorDocToContact({
        openId: "ou_1",
        name: "Jane",
        email: "jane@fenchem.com",
        department: "Sales",
        avatarUrl: "a72",
      }),
    ).toEqual({
      openId: "ou_1",
      name: "Jane",
      email: "jane@fenchem.com",
      department: "Sales",
      avatarUrl: "a72",
    });
  });
});
