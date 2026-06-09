import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRequestSyncSnapshot,
  readRequestSyncSnapshot,
  rememberRequestSyncSnapshot,
} from "./requestSyncSnapshot";

const NOW = new Date("2026-06-05T02:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("requestSyncSnapshot", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("remembers a synced row by normalized mailbox and conversation id", () => {
    rememberRequestSyncSnapshot(
      {
        userEmail: " Jenny.Xu@Fenchem.com ",
        conversationId: " conv-1 ",
        internetMessageId: " <x@bayerpharma.de> ",
      },
      {
        recordId: "rec_existing",
        detailUrl: "https://feishu.cn/base/rec_existing",
        coworkerCount: 1,
        syncedAt: NOW - DAY_MS,
      },
      NOW,
    );

    expect(
      readRequestSyncSnapshot(
        { userEmail: "jenny.xu@fenchem.com", conversationId: "conv-1" },
        NOW,
      ),
    ).toEqual({
      status: "synced",
      recordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/rec_existing",
      coworkerCount: 1,
      syncedAt: NOW - DAY_MS,
      error: null,
    });
  });

  it("falls back to internetMessageId when Outlook conversation id changes", () => {
    rememberRequestSyncSnapshot(
      {
        userEmail: "jenny.xu@fenchem.com",
        conversationId: "conv-original",
        internetMessageId: "<x@bayerpharma.de>",
      },
      { recordId: "rec_existing", detailUrl: null },
      NOW,
    );

    expect(
      readRequestSyncSnapshot(
        {
          userEmail: "jenny.xu@fenchem.com",
          conversationId: "conv-reopened",
          internetMessageId: "<x@bayerpharma.de>",
        },
        NOW,
      ),
    ).toMatchObject({
      status: "synced",
      recordId: "rec_existing",
    });
  });

  it("expires cached rows and does not fabricate incomplete identities", () => {
    rememberRequestSyncSnapshot(
      { userEmail: "jenny.xu@fenchem.com", conversationId: "conv-1" },
      { recordId: "rec_existing", detailUrl: null },
      NOW,
    );

    expect(
      readRequestSyncSnapshot(
        { userEmail: "jenny.xu@fenchem.com", conversationId: "conv-1" },
        NOW + 31 * DAY_MS,
      ),
    ).toBeNull();
    expect(
      readRequestSyncSnapshot(
        { userEmail: "jenny.xu@fenchem.com", conversationId: "" },
        NOW,
      ),
    ).toBeNull();
  });

  it("clears one cached conversation when Convex invalidates it", () => {
    const identity = {
      userEmail: "jenny.xu@fenchem.com",
      conversationId: "conv-1",
      internetMessageId: "<x@bayerpharma.de>",
    };
    rememberRequestSyncSnapshot(identity, { recordId: "rec_existing", detailUrl: null }, NOW);

    clearRequestSyncSnapshot(identity);

    expect(readRequestSyncSnapshot(identity, NOW)).toBeNull();
    expect(
      readRequestSyncSnapshot(
        {
          userEmail: identity.userEmail,
          conversationId: "conv-reopened",
          internetMessageId: identity.internetMessageId,
        },
        NOW,
      ),
    ).toBeNull();
  });
});
