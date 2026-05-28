// CustomerPicker behavior — the card on the contacts screen that shows the
// resolved Customer match for the current client email and lets the salesperson
// search the Customer Directory to override it (ADR-0013). The picker is fully
// controlled: the parent owns `selectedCustomer` and computes the initial
// auto-match via findCustomerByEmail; this component only displays + interacts.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CustomerPicker } from "./CustomerPicker";

const BAYER = {
  recordId: "rec_bayer",
  name: "Bayer Pharma",
  domain: "bayerpharma.de",
  owner: null,
};

const STOCKMEIER = {
  recordId: "rec_stock",
  name: "STOCKMEIER Chemie GmbH & Co. KG",
  domain: "stockmeier.com",
  owner: null,
};

describe("CustomerPicker", () => {
  it("renders the selected Customer's name as the chip", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [] }}
        searchCustomers={vi.fn()}
        emailDomain="bayerpharma.de"
        selectedCustomer={BAYER}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Bayer Pharma")).toBeInTheDocument();
  });

});

describe("CustomerPicker no-match states", () => {
  // Lenient no-match (ADR-0013): when the email domain doesn't resolve to a
  // Customer the picker says so without blocking the sync. A disabled "+ Add
  // new customer" placeholder reserves the slot for the future create-new
  // path (Bitable create vs Feishu form — see ADR-0013 future work).
  it("shows a no-match message and the disabled 'Add new customer' placeholder when nothing is selected and directory is ready", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [] }}
        searchCustomers={vi.fn()}
        emailDomain="unknown.io"
        selectedCustomer={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/no customer matched for unknown\.io/i)).toBeInTheDocument();
    const placeholder = screen.getByRole("button", { name: /add new customer/i });
    expect(placeholder).toBeDisabled();
  });

  // Non-blocking preload (ADR-0013): the picker mounts before the directory
  // finishes loading. While loading we say so instead of falsely showing a
  // "no match" state.
  it("shows a 'resolving' message while the directory is still loading", () => {
    render(
      <CustomerPicker
        directory={{ status: "loading", records: [] }}
        searchCustomers={vi.fn()}
        emailDomain="bayerpharma.de"
        selectedCustomer={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/resolving customer/i)).toBeInTheDocument();
    expect(screen.queryByText(/no customer matched/i)).not.toBeInTheDocument();
  });

});

describe("CustomerPicker override search", () => {
  // Override flow: the salesperson can override the auto-match by tapping
  // Change, typing into a search box, and picking from the results. The local
  // search runs against the in-memory Customer Directory (ADR-0013).
  it("opens a search input + lists matching directory rows when Change is clicked", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [BAYER, STOCKMEIER] }}
        searchCustomers={vi.fn()}
        emailDomain="bayerpharma.de"
        selectedCustomer={BAYER}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change/i }));

    const search = screen.getByRole("searchbox", { name: /search customers/i });
    fireEvent.change(search, { target: { value: "stock" } });

    expect(
      screen.getByRole("button", { name: /STOCKMEIER Chemie/i }),
    ).toBeInTheDocument();
  });

  // Override commit: tapping a result fires onChange with the chosen Customer
  // and dismisses the search panel back to the chip view.
});

describe("CustomerPicker override commit", () => {
  it("fires onChange and closes the search panel when a result is picked", () => {
    const onChange = vi.fn();
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [BAYER, STOCKMEIER] }}
        searchCustomers={vi.fn()}
        emailDomain="bayerpharma.de"
        selectedCustomer={BAYER}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: /search customers/i }), {
      target: { value: "stock" },
    });
    fireEvent.click(screen.getByRole("button", { name: /STOCKMEIER Chemie/i }));

    expect(onChange).toHaveBeenCalledWith(STOCKMEIER);
    // Back to chip view — search input is no longer rendered.
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});
