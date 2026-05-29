// Unit tests for the pure Search-Users -> Coworker projection. The Search Users
// API (open.feishu.cn GET /open-apis/search/v1/user) returns each hit as a
// FeishuUser carrying open_id, name, and a sized `avatar` object. Bitable Sync
// assigns Coworkers by open_id and only surfaces the 72px avatar (ADR-0003).
// The mapper has no Convex/IO dependency so it is unit-tested in isolation,
// mirroring customers.ts's exported `mapFeishuItemToCustomer`.

import { describe, expect, it } from "vitest";

import { mapCoworkers, mapFeishuUserToCoworker, type FeishuUser } from "./coworkers";

describe("mapFeishuUserToCoworker", () => {
  it("projects open_id->openId, name->name, and avatar.avatar_72->avatarUrl", () => {
    const u: FeishuUser = {
      open_id: "ou_jenny",
      name: "Jenny Xu",
      avatar: {
        avatar_72: "https://feishu/avatar/72.png",
        avatar_240: "https://feishu/avatar/240.png",
        avatar_640: "https://feishu/avatar/640.png",
        avatar_origin: "https://feishu/avatar/origin.png",
      },
      department_ids: ["od_1"],
    };
    expect(mapFeishuUserToCoworker(u)).toEqual({
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: "https://feishu/avatar/72.png",
    });
  });

  // `avatar` is optional on the Search-Users hit; the picker simply renders a
  // placeholder when no avatar comes back.
  it("leaves avatarUrl undefined when the avatar object is absent", () => {
    const result = mapFeishuUserToCoworker({ open_id: "ou_x", name: "No Avatar" });
    expect(result).toEqual({ openId: "ou_x", name: "No Avatar", avatarUrl: undefined });
    expect(result.avatarUrl).toBeUndefined();
  });

  // The mapper reads ONLY avatar_72 — a hit that carries the larger sizes but
  // not the 72px one must surface avatarUrl as undefined (no fallback to 240).
  it("leaves avatarUrl undefined when avatar exists but avatar_72 is missing", () => {
    const result = mapFeishuUserToCoworker({
      open_id: "ou_y",
      name: "Big Only",
      avatar: { avatar_240: "https://feishu/240.png", avatar_640: "https://feishu/640.png" },
    });
    expect(result.avatarUrl).toBeUndefined();
  });
});

describe("mapCoworkers", () => {
  it("maps every user in data.users through mapFeishuUserToCoworker", () => {
    const data = {
      users: [
        { open_id: "ou_a", name: "Alice", avatar: { avatar_72: "a72" } },
        { open_id: "ou_b", name: "Bob" },
      ],
    };
    expect(mapCoworkers(data)).toEqual([
      { openId: "ou_a", name: "Alice", avatarUrl: "a72" },
      { openId: "ou_b", name: "Bob", avatarUrl: undefined },
    ]);
  });

  // Official GET /search/v1/user omits `users` entirely on a no-hit query; the
  // `?? []` fallback must yield an empty list rather than throwing.
  it("returns [] when data.users is undefined (no hits)", () => {
    expect(mapCoworkers({})).toEqual([]);
  });

  it("returns [] when data.users is an empty array", () => {
    expect(mapCoworkers({ users: [] })).toEqual([]);
  });
});
