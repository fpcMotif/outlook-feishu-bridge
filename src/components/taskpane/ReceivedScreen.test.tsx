// ReceivedScreen behavior — the success screen after a Bitable Sync. Covers
// buildSteps coworker pluralization, the three-step timeline (last row has no
// connector line), every SelfForwardChip state (null/ok/pending/failed) plus the
// retry button presence/click, and the 'Route another email' callback.

/* eslint-disable max-lines-per-function */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReceivedScreen } from "./ReceivedScreen";

function renderScreen(overrides: Partial<React.ComponentProps<typeof ReceivedScreen>> = {}) {
  const onSyncAnother = vi.fn();
  const props: React.ComponentProps<typeof ReceivedScreen> = {
    coworkerCount: 1,
    onSyncAnother,
    ...overrides,
  };
  const utils = render(<ReceivedScreen {...props} />);
  return { onSyncAnother, ...utils };
}

describe("ReceivedScreen buildSteps coworker pluralization", () => {
  it("renders '1 coworker attached' for coworkerCount === 1 (singular)", () => {
    renderScreen({ coworkerCount: 1 });
    expect(screen.getByText("1 coworker attached")).toBeInTheDocument();
  });

  it("renders '2 coworkers attached' for coworkerCount === 2 (plural)", () => {
    renderScreen({ coworkerCount: 2 });
    expect(screen.getByText("2 coworkers attached")).toBeInTheDocument();
  });

  it("renders 'Request details attached' for coworkerCount === 0", () => {
    renderScreen({ coworkerCount: 0 });
    expect(screen.getByText("Request details attached")).toBeInTheDocument();
  });
});

describe("ReceivedScreen step timeline", () => {
  it("renders the three step titles", () => {
    renderScreen();
    expect(screen.getByText("Submitted")).toBeInTheDocument();
    expect(screen.getByText("Bitable row created")).toBeInTheDocument();
    expect(screen.getByText("Convex backup saved")).toBeInTheDocument();
  });

  it("draws a connector line on every row except the last (last prop)", () => {
    const { container } = renderScreen();
    // The connector is the absolutely-positioned vertical bar; 3 rows -> 2 lines.
    const connectors = container.querySelectorAll("span.absolute.top-5");
    expect(connectors).toHaveLength(2);
  });
});

describe("ReceivedScreen SelfForwardChip", () => {
  it("renders nothing when status is null (default)", () => {
    renderScreen({ selfForwardStatus: null });
    expect(screen.queryByText("Note to myself sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Sending Note to myself…")).not.toBeInTheDocument();
    expect(screen.queryByText("Note-to-myself failed")).not.toBeInTheDocument();
  });

  it("renders the OK chip with text when status is 'ok'", () => {
    renderScreen({ selfForwardStatus: "ok" });
    expect(screen.getByText("Note to myself sent")).toBeInTheDocument();
  });

  it("renders the pending chip when status is 'pending'", () => {
    renderScreen({ selfForwardStatus: "pending" });
    expect(screen.getByText("Sending Note to myself…")).toBeInTheDocument();
  });

  it("renders the failed chip and a retry button (calling onRetry) when status='failed' with onRetry", () => {
    const onRetrySelfForward = vi.fn();
    renderScreen({ selfForwardStatus: "failed", onRetrySelfForward });
    expect(screen.getByText("Note-to-myself failed")).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Retry note-to-myself" });
    fireEvent.click(retry);
    expect(onRetrySelfForward).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button when status='failed' but no onRetry is provided", () => {
    renderScreen({ selfForwardStatus: "failed" });
    expect(screen.getByText("Note-to-myself failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry note-to-myself" })).not.toBeInTheDocument();
  });
});

describe("ReceivedScreen 'Route another email'", () => {
  it("calls onSyncAnother when clicked", () => {
    const { onSyncAnother } = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Route another email" }));
    expect(onSyncAnother).toHaveBeenCalledTimes(1);
  });
});
