import { describe, expect, it } from "vitest";

import { coworkerAvatarUrl, mapCoworkers, mapFeishuUserToCoworker, type FeishuUser } from "./coworkers";

describe("Coworker Search Users mapping", () => {
  it("maps open_id, name, and avatar_72", () => {
    const user: FeishuUser = {
      open_id: "ou_jenny",
      name: "Jenny Xu",
      avatar: { avatar_72: "https://feishu/avatar-72.png" },
    };

    expect(mapFeishuUserToCoworker(user)).toEqual({
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: "https://feishu/avatar-72.png",
    });
  });

  it("falls back to larger Feishu avatar fields when avatar_72 is absent", () => {
    expect(
      coworkerAvatarUrl({
        open_id: "ou_big",
        name: "Big Avatar",
        avatar: { avatar_240: "https://feishu/avatar-240.png" },
      }),
    ).toBe("https://feishu/avatar-240.png");
  });

  it("falls back to top-level avatar_url when the avatar object is absent", () => {
    expect(
      coworkerAvatarUrl({
        open_id: "ou_top",
        name: "Top Level Avatar",
        avatar_url: "https://feishu/avatar-url.png",
      }),
    ).toBe("https://feishu/avatar-url.png");
  });

  it("returns [] when Search Users returns no users array", () => {
    expect(mapCoworkers({})).toEqual([]);
  });
});
