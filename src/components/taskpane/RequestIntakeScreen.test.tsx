/* eslint-disable require-unicode-regexp */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
  }),
}));

vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
}));

vi.mock("../../hooks/useCoworkerSearch", () => {
  const testAvatar =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const coworkers = [
    { openId: "ou_jenny", name: "Jenny Xu", avatarUrl: testAvatar },
    { openId: "ou_michael", name: "Michael Chen", avatarUrl: testAvatar },
    { openId: "ou_sales_ops", name: "Sales Ops" },
    { openId: "ou_wei", name: "Wei Liang" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(coworkers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))),
      ),
  };
});

const MICROSOFT = {
  recordId: "rec_microsoft",
  name: "Microsoft",
  domain: "microsoft.com",
  owner: null,
};

const FANPC = {
  recordId: "dev_fixture_fanpc_customer",
  name: "fanpc",
  domain: "fenchem.com",
  owner: { openId: "ou_dev", name: "fanpc" },
};

let customerDirectoryRecords = [FANPC, MICROSOFT];

vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: customerDirectoryRecords },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn((email: string) =>
      Promise.resolve(
        email.endsWith("@fenchem.com")
          ? FANPC
          : email.endsWith("@microsoftonline.com") || email.endsWith("@microsoft.com")
            ? MICROSOFT
            : null,
      ),
    ),
    triggerRefresh: vi.fn(),
  }),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import type { MailItemData } from "../../office/useMailItem";

const SAMPLE: MailItemData = {
  subject: "Inquiry - bulk pricing",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: [],
  body: "We need quarterly pricing.",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<x@bayerpharma.de>",
  itemId: "item-1",
  conversationId: "conv-1",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [],
};

function renderRequestIntakeScreen(
  isLoggedIn: boolean,
  clientEmail = "m.hoffmann@bayerpharma.de",
) {
  render(
    <RequestIntakeScreen
      isLoggedIn={isLoggedIn}
      mailItem={{ ...SAMPLE, from: clientEmail }}
      sessionId="test-session"
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

function fillQuotation() {
  fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
  fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
}

async function searchCoworker(name: string) {
  if (!screen.queryByLabelText("Search Feishu coworkers")) {
    const coworkerRow = document.querySelector('[data-coworker-row="true"]');
    if (coworkerRow) {
      fireEvent.click(within(coworkerRow as HTMLElement).getByRole("button", { name: /change/i }));
    }
  }
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: name },
  });
  return await screen.findByRole("button", { name: new RegExp(`^${name}`, "i") });
}

beforeEach(() => {
  localStorage.clear();
  customerDirectoryRecords = [FANPC, MICROSOFT];
  vi.restoreAllMocks();
});

describe("RequestIntakeScreen login gate", () => {
  it("keeps the Feishu login surface separate from the request builder", () => {
    renderRequestIntakeScreen(false);

    expect(screen.getByRole("button", { name: /Continue with Feishu/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request below/i }),
    ).not.toBeInTheDocument();
  });

  it("shows request details and client/coworker controls together after sign-in", () => {
    renderRequestIntakeScreen(true);

    expect(screen.queryByRole("button", { name: /Continue with Feishu/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByText("Pick a coworker")).toBeInTheDocument();
    const heroHeading = screen.getByRole("heading", { name: "Sales Services" });
    const customerSection = screen.getByText("Customer & coworker");
    const newRequestSection = screen.getByText("New request");
    expect(heroHeading.compareDocumentPosition(customerSection)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(customerSection.compareDocumentPosition(newRequestSection)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.queryByText("Search by name to choose a Feishu coworker")).not.toBeInTheDocument();
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Select a customer/i }),
    ).toBeDisabled();
  });
});

describe("RequestIntakeScreen request details", () => {
  it("marks filled request cards as selected", () => {
    renderRequestIntakeScreen(true);

    fillQuotation();

    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("keeps request details and client/coworker selection on one screen before submit", () => {
    renderRequestIntakeScreen(true);
    fillQuotation();

    expect(screen.getByText("Customer & coworker")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    expect(screen.getByText("Pick a coworker")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Need a quarterly L-Carnitine quote.")).toBeInTheDocument();
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Select a customer/i }),
    ).toBeDisabled();
  });

  it("lets users confirm and update the retrieved email", () => {
    renderRequestIntakeScreen(true);
    fillQuotation();

    const emailField = screen.getByLabelText("Email");

    expect(emailField.tagName).toBe("TEXTAREA");

    fireEvent.change(emailField, {
      target: { value: "elise.hoffmann-research-and-development@bayerpharma.de" },
    });

    expect(
      screen.getByDisplayValue("elise.hoffmann-research-and-development@bayerpharma.de"),
    ).toBeInTheDocument();

    fireEvent.change(emailField, {
      target: { value: "élise.hoffmann@bayerpharma.de" },
    });

    expect(screen.getByDisplayValue("élise.hoffmann@bayerpharma.de")).toBeInTheDocument();
  });

  it("opens the mocked create-customer page in a new browser tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderRequestIntakeScreen(true);

    fireEvent.click(screen.getByRole("button", { name: /search customer/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "fff" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create customer task "fff"/i }));

    expect(open).toHaveBeenCalledWith(
      "https://example.com/?task=create-customer&name=fff",
      "_blank",
      "noopener,noreferrer",
    );
  });

});

describe("RequestIntakeScreen customer auto-match", () => {
  it("auto-matches Microsoft from microsoft-noreply@microsoft.com", () => {
    renderRequestIntakeScreen(true, "microsoft-noreply@microsoft.com");

    expect(screen.getByText("Microsoft")).toBeInTheDocument();
    expect(screen.queryByText(/No match/i)).not.toBeInTheDocument();
  });

  it("auto-matches Microsoft from microsoftonline.com", () => {
    renderRequestIntakeScreen(true, "alerts@microsoftonline.com");

    expect(screen.getByText("Microsoft")).toBeInTheDocument();
    expect(screen.queryByText(/No match/i)).not.toBeInTheDocument();
  });

  it("auto-matches fanpc from fanpc@fenchem.com", () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");

    expect(screen.getByText("fanpc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
    expect(screen.queryByText(/No match/i)).not.toBeInTheDocument();
  });

  it("keeps the async Convex mirror match when the local directory is empty", async () => {
    customerDirectoryRecords = [];

    renderRequestIntakeScreen(true, "fanpc@fenchem.com");

    expect(await screen.findByText("fanpc")).toBeInTheDocument();
    expect(screen.queryByText(/No matched/i)).not.toBeInTheDocument();
  });
});

describe("RequestIntakeScreen coworker selection", () => {
  it("allows exactly one coworker and replaces the selection on the cards", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();

    fireEvent.click(await searchCoworker("Jenny Xu"));
    const jennyRow = document.querySelector('[data-coworker-row="true"]');
    expect(jennyRow).not.toBeNull();
    expect(within(jennyRow as HTMLElement).getByText("Jenny Xu")).toBeInTheDocument();
    expect(within(jennyRow as HTMLElement).getByRole("button", { name: /change/i })).toBeInTheDocument();
    expect(screen.queryByText("Pick a coworker")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search Feishu coworkers")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeInTheDocument();

    fireEvent.click(await searchCoworker("Michael Chen"));
    const michaelRow = document.querySelector('[data-coworker-row="true"]');
    expect(within(michaelRow as HTMLElement).getByText("Michael Chen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync with Michael Chen/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove coworker/i })).not.toBeInTheDocument();
  });

  it("shows Feishu avatar on the selected coworker row when avatarUrl is set", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();

    fireEvent.click(await searchCoworker("Jenny Xu"));

    const coworkerRow = document.querySelector('[data-coworker-row="true"]') as HTMLElement;
    expect(coworkerRow).not.toBeNull();
    expect(coworkerRow.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    expect(coworkerRow.querySelector(':scope > span[aria-hidden="true"]')).not.toHaveClass(
      "text-muted-foreground",
    );
  });

  it("shows coworker icon when selected coworker has no avatarUrl", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();

    fireEvent.click(await searchCoworker("Sales Ops"));

    const coworkerRow = document.querySelector('[data-coworker-row="true"]') as HTMLElement;
    expect(coworkerRow).not.toBeNull();
    expect(coworkerRow.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(coworkerRow.querySelector(':scope > span[aria-hidden="true"]')).toHaveClass(
      "text-muted-foreground",
    );
    expect(coworkerRow.querySelector("svg")).toBeInTheDocument();
  });

  it("shows the selected coworker in the same card stack as customer", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();

    fireEvent.click(await searchCoworker("Jenny Xu"));

    const customerRow = document.querySelector('[data-customer-row="true"]');
    const coworkerRow = document.querySelector('[data-coworker-row="true"]');
    expect(customerRow).not.toBeNull();
    expect(coworkerRow).not.toBeNull();
    expect(customerRow?.closest("section.bg-card-soft")).toBe(coworkerRow?.closest("section.bg-card-soft"));
  });
});

describe("RequestIntakeScreen sync flow", () => {
  it("shows Act IV while syncing, then the success screen once sync resolves", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();

    fireEvent.click(await searchCoworker("Jenny Xu"));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: /Synced to Feishu/i }),
    ).toBeInTheDocument();
  });
});

describe("RequestIntakeScreen submit dock gate", () => {
  it("stays disabled for request + coworker without a customer", async () => {
    renderRequestIntakeScreen(true);
    fillQuotation();
    fireEvent.click(await searchCoworker("Jenny Xu"));

    expect(
      screen.getByRole("button", { name: /Select a customer/i }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Sync with Jenny Xu/i })).not.toBeInTheDocument();
  });

  it("stays disabled for request + customer without a coworker", () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();

    expect(
      screen.getByRole("button", { name: /Choose exactly one Feishu coworker/i }),
    ).toBeDisabled();
  });

  it("stays disabled for customer + coworker without a fulfilled request", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fireEvent.click(await searchCoworker("Jenny Xu"));

    expect(
      screen.getByRole("button", { name: /Start a request below/i }),
    ).toBeDisabled();
  });

  it("enables sync only when customer, coworker, and a request note are set", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillQuotation();
    fireEvent.click(await searchCoworker("Jenny Xu"));

    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeEnabled();
  });
});
