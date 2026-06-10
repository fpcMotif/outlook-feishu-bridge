// Unit tests for the Intake Session State choreography — the pinned pane's
// enter → leave → clear lifecycle exercised at module level, with no React
// mount. The A→B→A switch+restore behaviour the integration tests drive
// through the full component tree is pinned here as a unit: leave snapshots,
// restore rehydrates, synced/cleared conversations never resurrect.

import { beforeEach, describe, expect, it } from "vitest";

import { initialIntakeState, type IntakeState, type UploadedFile } from "./intakeReducer";
import { buildIntakeDraftKey, clearIntakeDraft } from "./intakeDraftCache";
import {
  openIntakeSession,
  wipeIntakeSessionsOnLogout,
  type IntakeSessionIdentity,
} from "./intakeSessionState";

const identity: IntakeSessionIdentity = {
  openId: "ou_alice",
  userEmail: "Shared@Fenchem.com",
  conversationId: "conv-1",
  mailKey: "Re: pricing|client@acme.com|conv-1",
};

const MAIL_FROM = "client@acme.com";

function completedUpload(id: string, storageId: string): UploadedFile {
  return {
    id,
    file: new File(["bytes"], `${id}.pdf`, { type: "application/pdf" }),
    rejection: null,
    selected: true,
    status: "complete",
    progress: 100,
    storageId,
    uploadError: null,
  };
}

function buildState(over: Partial<IntakeState> = {}): IntakeState {
  return {
    ...initialIntakeState({ mailFrom: MAIL_FROM, restoredUploads: [] }),
    ...over,
  };
}

beforeEach(() => {
  wipeIntakeSessionsOnLogout();
});

describe("openIntakeSession — restore-on-enter", () => {
  it("gives a fresh build state when nothing is cached", () => {
    const state = openIntakeSession(identity).restore(MAIL_FROM);
    expect(state.screen).toBe("build");
    expect(state.notes).toEqual({});
    expect(state.uploadedFiles).toEqual([]);
  });

  it("seeded uploads (DEV fixture channel) bypass the Upload draft", () => {
    const seeded = [completedUpload("u9", "st_9")];
    const state = openIntakeSession(identity).restore(MAIL_FROM, seeded);
    expect(state.uploadedFiles).toEqual(seeded);
  });
});

describe("openIntakeSession — leave → re-enter (the A→B→A switch)", () => {
  it("restores picks, notes and uploads after a build-screen leave", () => {
    const leaving = buildState({
      notes: { request: "100kg of XYZ at target $4/kg" },
      selectedSales: { openId: "ou_colleague", name: "Michael" },
      uploadedFiles: [completedUpload("u1", "st_1")],
    });
    openIntakeSession(identity).leave(leaving);

    const restored = openIntakeSession(identity).restore(MAIL_FROM);
    expect(restored.notes).toEqual({ request: "100kg of XYZ at target $4/kg" });
    expect(restored.selectedSales?.openId).toBe("ou_colleague");
    expect(restored.uploadedFiles.map((u) => u.storageId)).toEqual(["st_1"]);
  });

  it("normalizes a transient overlay screen back to build and drops the sync error", () => {
    openIntakeSession(identity).leave(
      buildState({ screen: "error", syncError: "Could not sync", notes: { request: "hi" } }),
    );
    const restored = openIntakeSession(identity).restore(MAIL_FROM);
    expect(restored.screen).toBe("build");
    expect(restored.syncError).toBeNull();
    expect(restored.notes).toEqual({ request: "hi" });
  });

  it("falls back to the Upload draft when the intake draft is gone (e.g. LRU-evicted)", () => {
    openIntakeSession(identity).leave(
      buildState({ uploadedFiles: [completedUpload("u1", "st_1")], notes: { request: "hi" } }),
    );
    // Simulate the intake draft alone being evicted; the Upload draft survives.
    clearIntakeDraft(buildIntakeDraftKey(identity.openId, identity.userEmail, identity.mailKey));

    const restored = openIntakeSession(identity).restore(MAIL_FROM);
    expect(restored.notes).toEqual({});
    expect(restored.uploadedFiles).toHaveLength(1);
    const upload = restored.uploadedFiles[0];
    expect(upload.storageId).toBe("st_1");
    expect(upload.status).toBe("complete");
    expect(upload.file.name).toBe("u1.pdf");
  });
});

describe("openIntakeSession — synced conversations never resurrect", () => {
  it("a received-screen leave drops both drafts", () => {
    openIntakeSession(identity).leave(
      buildState({
        screen: "received",
        notes: { request: "synced already" },
        uploadedFiles: [completedUpload("u1", "st_1")],
      }),
    );
    const restored = openIntakeSession(identity).restore(MAIL_FROM);
    expect(restored.notes).toEqual({});
    expect(restored.uploadedFiles).toEqual([]);
  });

  it("clearDrafts pins the session cleared — a later leave cannot re-snapshot", () => {
    const session = openIntakeSession(identity);
    session.clearDrafts();
    // Even a build-screen leave after the clear must not write the dead draft
    // back (its storageIds were consumed server-side by the sync).
    session.leave(
      buildState({ notes: { request: "stale" }, uploadedFiles: [completedUpload("u1", "st_1")] }),
    );
    const restored = openIntakeSession(identity).restore(MAIL_FROM);
    expect(restored.notes).toEqual({});
    expect(restored.uploadedFiles).toEqual([]);
  });
});

describe("openIntakeSession — identity scoping", () => {
  it("two Feishu accounts on one shared mailbox + conversation never share a session", () => {
    openIntakeSession(identity).leave(buildState({ notes: { request: "alice's draft" } }));
    const bob = openIntakeSession({ ...identity, openId: "ou_bob" });
    expect(bob.restore(MAIL_FROM).notes).toEqual({});
    // Alice's draft is untouched by Bob's fresh session.
    expect(openIntakeSession(identity).restore(MAIL_FROM).notes).toEqual({
      request: "alice's draft",
    });
  });

  it("an identity that cannot form keys degrades to fresh state and no-op persistence", () => {
    const keyless = openIntakeSession({ ...identity, userEmail: undefined });
    expect(keyless.restore(MAIL_FROM).notes).toEqual({});
    expect(() =>
      keyless.leave(buildState({ notes: { request: "nowhere to go" } })),
    ).not.toThrow();
    expect(openIntakeSession({ ...identity, userEmail: undefined }).restore(MAIL_FROM).notes).toEqual({});
  });
});

describe("wipeIntakeSessionsOnLogout", () => {
  it("drops every conversation's drafts across both stores", () => {
    openIntakeSession(identity).leave(
      buildState({ notes: { request: "a" }, uploadedFiles: [completedUpload("u1", "st_1")] }),
    );
    openIntakeSession({ ...identity, conversationId: "conv-2", mailKey: "other|x|conv-2" }).leave(
      buildState({ notes: { request: "b" } }),
    );
    wipeIntakeSessionsOnLogout();
    expect(openIntakeSession(identity).restore(MAIL_FROM).notes).toEqual({});
    expect(openIntakeSession(identity).restore(MAIL_FROM).uploadedFiles).toEqual([]);
    expect(
      openIntakeSession({ ...identity, conversationId: "conv-2", mailKey: "other|x|conv-2" }).restore(
        MAIL_FROM,
      ).notes,
    ).toEqual({});
  });
});
