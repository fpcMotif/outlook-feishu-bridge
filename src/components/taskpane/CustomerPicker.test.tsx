// CustomerPicker behavior — the card on the contacts screen that shows the
// resolved Customer match for the current email and lets the salesperson
// search the Customer Directory to override it (ADR-0013). The picker is fully
// controlled: the parent owns `selectedCustomer` and computes the initial
// auto-match via findCustomerByEmail; this component only displays + interacts.

/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoworkerPicker } from "./CoworkerPicker";
import { CustomerPicker } from "./CustomerPicker";

vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));

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

  it("fires server search per keystroke for short no-match queries (ADR-0020 per-keystroke)", async () => {
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
      target: { value: "n" },
    });

    // The 250ms debounce + min-length gate were dropped; a single no-local-match
    // character hits the server immediately.
    expect(searchCustomers).toHaveBeenCalledWith("n", undefined);
    expect(await screen.findByRole("button", { name: /Novo Nordisk/i })).toBeInTheDocument();
  });

  it("still shows one-character local customer matches", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [BAYER] }}
        searchCustomers={vi.fn()}
        emailDomain="unknown.io"
        selectedCustomer={null}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search customer/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "b" },
    });

    expect(screen.getByRole("button", { name: /Bayer Pharma/i })).toBeInTheDocument();
  });

  it("skips server search while the local Customer Directory still has matches", () => {
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
      target: { value: "bayer" },
    });

    // "bayer" matches locally, so the server fallback stays untouched.
    expect(searchCustomers).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Bayer Pharma/i })).toBeInTheDocument();
  });

  it("fires server search synchronously (no debounce) when the local directory has no match", () => {
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

  it("does not pass mineFor to server search when the user is actively searching", async () => {
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
      expect(searchCustomers).toHaveBeenCalledWith("novo", undefined),
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
// a "Show mine" toggle limits browse (empty query) to the Initiator's customers;
// active search always queries the full directory (ADR-0014).
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

  it("shows an empty state when Show mine is on but the Initiator owns no customers", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [jennyRow] }}
        searchCustomers={vi.fn()}
        emailDomain="something.example"
        selectedCustomer={null}
        currentUserOpenId="ou_florian"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.click(screen.getByRole("button", { name: /show mine/i }));

    expect(screen.getByText(/no customers assigned to you/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show all customers/i })).not.toBeInTheDocument();
  });

  it("searches the full directory when Show mine is on but the user types a query", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [jennyRow] }}
        searchCustomers={vi.fn(() => Promise.resolve([]))}
        emailDomain="something.example"
        selectedCustomer={null}
        currentUserOpenId="ou_florian"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.click(screen.getByRole("button", { name: /show mine/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /search customers/i }), {
      target: { value: "beta" },
    });

    expect(screen.getByRole("button", { name: /Beta Pharma/i })).toBeInTheDocument();
    expect(screen.queryByText(/no matches among your customers/i)).not.toBeInTheDocument();
  });

  it("still browses owned customers only when Show mine is on with an empty query", () => {
    render(
      <CustomerPicker
        directory={{ status: "ready", records: [florianRow, jennyRow] }}
        searchCustomers={vi.fn(() => Promise.resolve([]))}
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

describe("CustomerPicker dismiss scope", () => {
  const jennyRow = {
    recordId: "rec_jenny",
    name: "Beta Pharma",
    domain: "beta.example",
    owner: { openId: "ou_jenny", name: "Jenny Xu" },
  };

  function renderEmbeddedCustomerSearch() {
    render(
      <CoworkerPicker
        sessionId="sess"
        selectedCoworker={null}
        onSelect={vi.fn()}
        customerSlot={
          <CustomerPicker
            directory={{ status: "ready", records: [jennyRow] }}
            searchCustomers={vi.fn()}
            emailDomain="unknown.io"
            selectedCustomer={null}
            currentUserOpenId="ou_florian"
            embedded
            onChange={vi.fn()}
          />
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.click(screen.getByRole("button", { name: /show mine/i }));
  }

  it("dismisses customer search when clicking the coworker search field", async () => {
    renderEmbeddedCustomerSearch();
    expect(screen.getByText(/no customers assigned to you/i)).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText(/search feishu coworkers/i));

    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: /search customers/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/no customers assigned to you/i)).not.toBeInTheDocument();
  });

  it("dismisses customer search when focus moves to the coworker search field", async () => {
    renderEmbeddedCustomerSearch();
    const customerSearch = screen.getByRole("combobox", { name: /search customers/i });
    const coworkerSearch = screen.getByLabelText(/search feishu coworkers/i);
    customerSearch.focus();
    expect(customerSearch).toHaveFocus();

    fireEvent.blur(customerSearch);
    coworkerSearch.focus();

    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: /search customers/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/no customers assigned to you/i)).not.toBeInTheDocument();
  });

  it("keeps customer search open when clicking inside the search panel", () => {
    renderEmbeddedCustomerSearch();
    expect(screen.getByRole("listbox", { name: /customer results/i })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: /search customers/i }));
    fireEvent.mouseDown(screen.getByRole("button", { name: /show mine/i }));

    expect(screen.getByRole("listbox", { name: /customer results/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /search customers/i })).toBeInTheDocument();
  });

  it("dismisses customer search when clicking outside the card", async () => {
    render(
      <div>
        <CoworkerPicker
          sessionId="sess"
          selectedCoworker={null}
          onSelect={vi.fn()}
          customerSlot={
            <CustomerPicker
              directory={{ status: "ready", records: [jennyRow] }}
              searchCustomers={vi.fn()}
              emailDomain="unknown.io"
              selectedCustomer={null}
              currentUserOpenId="ou_florian"
              embedded
              onChange={vi.fn()}
            />
          }
        />
        <button type="button">New request below</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.click(screen.getByRole("button", { name: /show mine/i }));
    expect(screen.getByText(/no customers assigned to you/i)).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("button", { name: "New request below" }));

    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: /search customers/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/no customers assigned to you/i)).not.toBeInTheDocument();
  });

  it("closes customer search on Escape when the query is empty", async () => {
    renderEmbeddedCustomerSearch();
    expect(screen.getByRole("combobox", { name: /search customers/i })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("combobox", { name: /search customers/i }), {
      key: "Escape",
    });

    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: /search customers/i })).not.toBeInTheDocument(),
    );
  });
});
