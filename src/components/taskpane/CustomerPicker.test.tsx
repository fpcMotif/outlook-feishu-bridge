// CustomerPicker behavior — the card on the contacts screen that shows the
// resolved Customer match for the current email and lets the salesperson
// search the Customer Directory to override it (ADR-0013). The picker is fully
// controlled: the parent owns `selectedCustomer` and computes the initial
// auto-match via findCustomerByEmail; this component only displays + interacts.

/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.useRealTimers();
});

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
  // path (Base create vs Feishu form — see ADR-0013 future work).
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

    expect(screen.getByText(/no match/i)).toBeInTheDocument();
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
    expect(screen.queryByText(/no match/i)).not.toBeInTheDocument();
  });

});

describe("CustomerPicker override search", () => {
  it("triggers a freshness refresh when the search panel opens", () => {
    const triggerRefresh = vi.fn();
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [BAYER] }}
        searchCustomers={vi.fn()}
        triggerRefresh={triggerRefresh}
        emailDomain="bayerpharma.de"
        selectedCustomer={BAYER}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change/i }));

    expect(triggerRefresh).toHaveBeenCalledTimes(1);
  });

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

    const search = screen.getByRole("combobox", { name: /search customers/i });
    fireEvent.change(search, { target: { value: "stock" } });

    expect(
      screen.getByRole("button", { name: /STOCKMEIER Chemie/i }),
    ).toBeInTheDocument();
  });

  // Override commit: tapping a result fires onChange with the chosen Customer
  // and dismisses the search panel back to the chip view.
});

describe("CustomerPicker server fallback", () => {
  const NOVO = {
    recordId: "rec_novo",
    name: "Novo Nordisk",
    domain: "novonordisk.com",
    owner: { openId: "ou_florian", name: "Florian Meurer" },
  };

  it("debounces server search when the local Customer Directory has no match", async () => {
    vi.useFakeTimers();
    const searchCustomers = vi.fn(() => Promise.resolve([NOVO]));
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [BAYER] }}
        searchCustomers={searchCustomers}
        emailDomain="unknown.io"
        selectedCustomer={null}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search customer/i }));
    const input = screen.getByRole("combobox", { name: /search customers/i });
    fireEvent.change(input, { target: { value: "n" } });
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.change(input, { target: { value: "novo" } });

    expect(searchCustomers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(searchCustomers).toHaveBeenCalledTimes(1);
    expect(searchCustomers).toHaveBeenCalledWith("novo", undefined);
  });

  it("uses server search when the local Customer Directory has no match", async () => {
    const searchCustomers = vi.fn(() => Promise.resolve([NOVO]));
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [BAYER] }}
        searchCustomers={searchCustomers}
        emailDomain="unknown.io"
        selectedCustomer={null}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search customer/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "novo" },
    });

    expect(await screen.findByRole("button", { name: /Novo Nordisk/i })).toBeInTheDocument();
    expect(searchCustomers).toHaveBeenCalledWith("novo", undefined);
  });

  it("offers a create-customer task action when search has no customer matches", () => {
    const onCreateCustomer = vi.fn();
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [] }}
        searchCustomers={vi.fn(() => Promise.resolve([]))}
        emailDomain="unknown.io"
        selectedCustomer={null}
        onChange={vi.fn()}
        onCreateCustomer={onCreateCustomer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search customer/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "ddddd" },
    });

    expect(
      screen.getByRole("button", { name: /create customer task "ddddd"/i }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /create customer task "ddddd"/i }));

    expect(onCreateCustomer).toHaveBeenCalledWith("ddddd");
  });

  it("passes the Initiator owner filter to server search when Show mine is enabled", async () => {
    const searchCustomers = vi.fn(() => Promise.resolve([NOVO]));
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [] }}
        searchCustomers={searchCustomers}
        emailDomain="unknown.io"
        selectedCustomer={null}
        currentUserOpenId="ou_florian"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search customer/i }));
    fireEvent.click(screen.getByRole("button", { name: /show mine/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "novo" },
    });

    await waitFor(() =>
      expect(searchCustomers).toHaveBeenCalledWith("novo", { mineFor: "ou_florian" }),
    );
  });
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
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "stock" },
    });
    fireEvent.click(screen.getByRole("button", { name: /STOCKMEIER Chemie/i }));

    expect(onChange).toHaveBeenCalledWith(STOCKMEIER);
    // Back to chip view — search input is no longer rendered.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

// Searching customers by their Owner — the Feishu user listed in the Customer
// Table's `Owner` column (projected as `owner: { openId, name }`). Typing the
// owner's name in the existing search box matches all customers owned by them;
// a "Show mine" toggle limits results to customers owned by the signed-in user
// (the Initiator, ADR-0014).
describe("CustomerPicker owner filter", () => {
  const florianRow = {
    recordId: "rec_florian_acct",
    name: "Acme Chemicals",
    domain: "acme.example",
    owner: { openId: "ou_florian", name: "Florian Meurer" },
  };
  const jennyRow = {
    recordId: "rec_jenny_acct",
    name: "Beta Pharma",
    domain: "beta.example",
    owner: { openId: "ou_jenny", name: "Jenny Xu" },
  };

  it("matches a customer whose owner.name contains the query", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [florianRow, jennyRow] }}
        searchCustomers={vi.fn()}
        emailDomain="something.example"
        selectedCustomer={null}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "florian" },
    });

    expect(screen.getByRole("button", { name: /Acme Chemicals/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Beta Pharma/i })).not.toBeInTheDocument();
  });

  it("filters to the Initiator's customers when 'Show mine' is on", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [florianRow, jennyRow] }}
        searchCustomers={vi.fn()}
        emailDomain="something.example"
        selectedCustomer={null}
        currentUserOpenId="ou_florian"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.click(screen.getByRole("button", { name: /show mine/i }));

    expect(screen.getByRole("button", { name: /Acme Chemicals/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Beta Pharma/i })).not.toBeInTheDocument();
  });
});
