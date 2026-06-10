import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCustomerAutoMatch } from "./useCustomerAutoMatch";
import type { CustomerRecord } from "../components/taskpane/customers";

function renderAutoMatch(clientEmail: string, records: CustomerRecord[] = []) {
  const matchEmail = vi.fn(async () => null);
  const dispatch = vi.fn();
  const result = renderHook(
    ({ email }) =>
      useCustomerAutoMatch({
        isLoggedIn: true,
        clientEmail: email,
        customerTouched: false,
        selectedCustomer: null,
        directory: { status: "ready", records },
        matchEmail,
        dispatch,
      }),
    { initialProps: { email: clientEmail } },
  );
  return { ...result, matchEmail, dispatch };
}

describe("useCustomerAutoMatch", () => {
  it("does not call mirror match for text without an email domain", async () => {
    const { result, matchEmail } = renderAutoMatch("not-an-email");

    await waitFor(() => {
      expect(result.current.emailDomainPart).toBe("");
    });

    expect(matchEmail).not.toHaveBeenCalled();
  });

  it("does not call mirror match for an incomplete email domain", async () => {
    const { result, matchEmail } = renderAutoMatch("buyer@");

    await waitFor(() => {
      expect(result.current.emailDomainPart).toBe("");
    });

    expect(matchEmail).not.toHaveBeenCalled();
  });

  it("still tries mirror match for a valid email domain", async () => {
    const { result, matchEmail } = renderAutoMatch("buyer@example.com");

    await waitFor(() => {
      expect(result.current.emailDomainPart).toBe("example.com");
      expect(matchEmail).toHaveBeenCalledWith("buyer@example.com");
    });
  });

  it("does not repeat mirror match when only the email local part changes", async () => {
    const { rerender, matchEmail } = renderAutoMatch("buyer@example.com");

    await waitFor(() => {
      expect(matchEmail).toHaveBeenCalledTimes(1);
    });

    rerender({ email: "accounts@example.com" });

    await waitFor(() => {
      expect(matchEmail).toHaveBeenCalledTimes(1);
    });
  });

  it("does not repeat local directory domain scan when only the email local part changes", () => {
    let domainReads = 0;
    const records = Array.from({ length: 100 }, (_, index) => ({
      recordId: `rec_${index}`,
      name: `Customer ${index}`,
      get domain() {
        domainReads += 1;
        return index === 99 ? "example.com" : `customer-${index}.test`;
      },
      owner: null,
    }));
    const { rerender } = renderAutoMatch("buyer@example.com", records);

    expect(domainReads).toBe(100);

    rerender({ email: "accounts@example.com" });

    expect(domainReads).toBe(100);
  });
});
