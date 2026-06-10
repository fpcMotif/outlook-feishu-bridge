// Owns the tangled Customer auto-match logic that used to live inline in
// RequestIntakeScreen: the local directory useMemo match (ADR-0013), the
// customerTouched reducer-guard interaction, and the async Convex mirror
// matchEmail effect. RequestIntakeScreen just calls this and forwards
// `dispatch`; the reducer still guards every write against a user override
// (customerTouched).
//
// A domain with no local hit no longer kicks a full Mirror Refresh here: the
// server-index matchEmail is itself cache-aside (mirror -> targeted one-page
// Feishu domain backfill on a true miss), so the async effect below already
// covers fresh rows lazily, at the cost of one filtered call instead of a
// full-table re-sync.

import { useEffect, useMemo, useRef } from "react";

import type { CustomerRecord } from "../components/taskpane/customers";
import { emailDomain, findCustomerByDomain } from "../components/taskpane/customers";
import type { CustomerSearch } from "./customerSearch";
import type { IntakeAction } from "../components/taskpane/intakeReducer";

interface UseCustomerAutoMatchArgs {
  isLoggedIn: boolean;
  clientEmail: string;
  customerTouched: boolean;
  selectedCustomer: CustomerRecord | null;
  directory: CustomerSearch["directory"];
  matchEmail: CustomerSearch["matchEmail"];
  dispatch: (action: IntakeAction) => void;
}

interface CustomerAutoMatchResult {
  emailDomainPart: string;
  autoMatchedCustomer: CustomerRecord | null;
  isSearching: boolean;
}

function deriveEmailDomainPart(clientEmail: string): string {
  return emailDomain(clientEmail) ?? "";
}

// Async fallback to the Convex mirror when the preloaded directory has no hit
// yet (e.g. directory still empty / not loaded). Cancellable on re-run.
function useAsyncMirrorMatch(args: UseCustomerAutoMatchArgs, emailDomainPart: string) {
  const { isLoggedIn, clientEmail, customerTouched, selectedCustomer, matchEmail, dispatch } = args;
  const attemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoggedIn || customerTouched || selectedCustomer) return;
    if (!emailDomainPart || attemptedFor.current === emailDomainPart) return;
    attemptedFor.current = emailDomainPart;
    let cancelled = false;
    void matchEmail(clientEmail).then((customer) => {
      if (!cancelled && customer) dispatch({ type: "customerAutoMatched", customer });
    });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, matchEmail, clientEmail, emailDomainPart, customerTouched, selectedCustomer, dispatch]);
}

export function useCustomerAutoMatch(args: UseCustomerAutoMatchArgs): CustomerAutoMatchResult {
  const { clientEmail, customerTouched, selectedCustomer, directory, dispatch } = args;
  const emailDomainPart = deriveEmailDomainPart(clientEmail);

  // Re-run the local auto-match whenever the directory finishes loading or the
  // client email changes. The reducer guards against clobbering a user override
  // (customerTouched); we also skip dispatch when the match already matches.
  const autoMatch = useMemo(
    () => (directory.status === "ready" ? findCustomerByDomain(directory.records, emailDomainPart) : null),
    [directory.status, directory.records, emailDomainPart],
  );
  if (
    !customerTouched &&
    directory.status === "ready" &&
    autoMatch !== null &&
    (autoMatch.recordId ?? null) !== (selectedCustomer?.recordId ?? null)
  ) {
    dispatch({ type: "customerAutoMatched", customer: autoMatch });
  }

  useAsyncMirrorMatch(args, emailDomainPart);

  return {
    emailDomainPart,
    autoMatchedCustomer: autoMatch,
    isSearching: directory.status === "loading",
  };
}
