import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCustomerAutoMatch } from "./useCustomerAutoMatch";

function renderAutoMatch(clientEmail: string) {
  const matchEmail = vi.fn(async () => null);
  const triggerRefresh = vi.fn();
  const dispatch = vi.fn();
  const result = renderHook(() =>
    useCustomerAutoMatch({
      isLoggedIn: true,
      clientEmail,
      customerTouched: false,
      selectedCustomer: null,
      directory: { status: "ready", records: [] },
      matchEmail,
      triggerRefresh,
      dispatch,
    }),
  );
  return { ...result, matchEmail, triggerRefresh, dispatch };
}

describe("useCustomerAutoMatch", () => {
  it("does not call mirror match or refresh for text without an email domain", async () => {
    const { result, matchEmail, triggerRefresh } = renderAutoMatch("not-an-email");

    await waitFor(() => {
      expect(result.current.emailDomainPart).toBe("");
    });

    expect(matchEmail).not.toHaveBeenCalled();
    expect(triggerRefresh).not.toHaveBeenCalled();
  });

  it("does not call mirror match or refresh for an incomplete email domain", async () => {
    const { result, matchEmail, triggerRefresh } = renderAutoMatch("buyer@");

    await waitFor(() => {
      expect(result.current.emailDomainPart).toBe("");
    });

    expect(matchEmail).not.toHaveBeenCalled();
    expect(triggerRefresh).not.toHaveBeenCalled();
  });

  it("still tries mirror match and refresh for a valid email domain", async () => {
    const { result, matchEmail, triggerRefresh } = renderAutoMatch("buyer@example.com");

    await waitFor(() => {
      expect(result.current.emailDomainPart).toBe("example.com");
      expect(matchEmail).toHaveBeenCalledWith("buyer@example.com");
      expect(triggerRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
