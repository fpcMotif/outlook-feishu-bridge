import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ForwardScreen, type ServiceRecordSyncInput } from "./ForwardScreen";
import type { SearchCoworkers } from "./CoworkerPicker";

const JENNY = { openId: "ou_real_jenny", name: "Jenny Xu" };
const searchCoworkers: SearchCoworkers = (query) =>
  Promise.resolve(query.toLowerCase().includes("jenny") ? [JENNY] : []);

function renderForwardScreen(
  isLoggedIn: boolean,
  clientEmail = "m.hoffmann@bayerpharma.de",
  onSyncServiceRecord?: (input: ServiceRecordSyncInput) => Promise<void>,
) {
  render(
    <ForwardScreen
      isLoggedIn={isLoggedIn}
      clientEmail={clientEmail}
      searchCoworkers={searchCoworkers}
      onSyncServiceRecord={onSyncServiceRecord}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

function fillQuotationAndContinue() {
  fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
}

async function searchJenny() {
  fireEvent.change(screen.getByPlaceholderText("Search Feishu coworkers..."), {
    target: { value: "Jenny" },
  });
  return await screen.findByRole("button", { name: /Jenny Xu/i });
}

describe("ForwardScreen login gate", () => {
  it("keeps the Feishu login surface separate from the request builder", () => {
    renderForwardScreen(false);

    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the request builder without the login prompt after sign-in", () => {
    renderForwardScreen(true);

    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start a request above/i }),
    ).toBeInTheDocument();
  });
});

describe("ForwardScreen request details", () => {
  it("marks filled request cards as selected", () => {
    renderForwardScreen(true);

    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });

    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("moves filled requests into Act II coworker selection before submit", async () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    expect(screen.getByText("Client & coworker")).toBeInTheDocument();
    expect(screen.getByText("Client email")).toBeInTheDocument();
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    expect(screen.queryByText("Need a quarterly L-Carnitine quote.")).not.toBeInTheDocument();
    expect(await searchJenny()).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Choose a Feishu coworker/i }),
    ).toBeDisabled();
  });

  it("lets users confirm and update the retrieved client email", () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "updated.client@example.com" },
    });

    expect(screen.getByDisplayValue("updated.client@example.com")).toBeInTheDocument();
  });

  it("keeps coworker selection on cards without selected tags", async () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    fireEvent.click(await searchJenny());

    expect(screen.getByRole("button", { name: /Submit to 1 coworker/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove coworker/i })).not.toBeInTheDocument();
  });
});

describe("ForwardScreen service sync payload", () => {
  it("calls the service-record sync with request content, client, and coworker", async () => {
    const onSyncServiceRecord = vi.fn(() => Promise.resolve());
    renderForwardScreen(true, "buyer@example.com", onSyncServiceRecord);
    fillQuotationAndContinue();

    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "updated.client@example.com" },
    });
    fireEvent.click(await searchJenny());
    fireEvent.click(screen.getByRole("button", { name: /Submit to 1 coworker/i }));

    expect(onSyncServiceRecord).toHaveBeenCalledWith({
      clientEmail: "updated.client@example.com",
      requestSelections: [
        { requestType: "Quotation", note: "Need a quarterly L-Carnitine quote." },
      ],
      selectedCoworkers: [JENNY],
    });
  });
});

describe("ForwardScreen sync progress", () => {
  it("shows Act IV while syncing before the success screen", async () => {
    vi.useFakeTimers();
    renderForwardScreen(true);
    fillQuotationAndContinue();

    fireEvent.change(screen.getByPlaceholderText("Search Feishu coworkers..."), {
      target: { value: "Jenny" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit to 1 coworker/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Bitable/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3600);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
