// Owns the tangled Customer auto-match logic that used to live inline in
// RequestIntakeScreen: the local directory useMemo match (ADR-0013), the
// customerTouched reducer-guard interaction, the async Convex mirror
// matchEmail effect, and the on-demand directory/mirror refresh effect.
// RequestIntakeScreen just calls this and forwards `dispatch`; the reducer
// still guards every write against a user override (customerTouched).

import { useEffect, useMemo, useRef } from "react";

import type { CustomerRecord } from "../components/taskpane/customers";
import { emailDomain, findCustomerByEmail } from "../components/taskpane/customers";
import type { CustomerSearch } from "./customerSearch";
import type { IntakeAction } from "../components/taskpane/intakeReducer";

interface UseCustomerAutoMatchArgs {
  isLoggedIn: boolean;
  clientEmail: string;
  customerTouched: boolean;
  selectedCustomer: CustomerRecord | null;
  directory: CustomerSearch["directory"];
  matchEmail: CustomerSearch["matchEmail"];
  triggerRefresh: CustomerSearch["triggerRefresh"];
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
function useAsyncMirrorMatch(args: UseCustomerAutoMatchArgs) {
  const { isLoggedIn, clientEmail, customerTouched, selectedCustomer, matchEmail, dispatch } = args;
  useEffect(() => {
    if (!isLoggedIn || customerTouched || selectedCustomer) return;
    if (!emailDomain(clientEmail)) return;
    let cancelled = false;
    void matchEmail(clientEmail).then((customer) => {
      if (!cancelled && customer) dispatch({ type: "customerAutoMatched", customer });
    });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, matchEmail, clientEmail, customerTouched, selectedCustomer, dispatch]);
}

// One-shot directory/mirror refresh per domain when a ready directory has no
// local hit, so a stale preload re-pages before giving up on a match.
function useRefreshOnNoMatch(
  args: UseCustomerAutoMatchArgs,
  autoMatch: CustomerRecord | null,
  emailDomainPart: string,
) {
  const { customerTouched, directory, triggerRefresh } = args;
  const attemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (customerTouched || directory.status !== "ready" || autoMatch) return;
    if (!emailDomainPart || attemptedFor.current === emailDomainPart) return;
    attemptedFor.current = emailDomainPart;
    triggerRefresh();
  }, [autoMatch, directory.status, emailDomainPart, customerTouched, triggerRefresh]);
}

export function useCustomerAutoMatch(args: UseCustomerAutoMatchArgs): CustomerAutoMatchResult {
  const { clientEmail, customerTouched, selectedCustomer, directory, dispatch } = args;
  const emailDomainPart = deriveEmailDomainPart(clientEmail);

  // Re-run the local auto-match whenever the directory finishes loading or the
  // client email changes. The reducer guards against clobbering a user override
  // (customerTouched); we also skip dispatch when the match already matches.
  const autoMatch = useMemo(
    () => (directory.status === "ready" ? findCustomerByEmail(directory.records, clientEmail) : null),
    [directory.status, directory.records, clientEmail],
  );
  if (
    !customerTouched &&
    directory.status === "ready" &&
    autoMatch !== null &&
    (autoMatch.recordId ?? null) !== (selectedCustomer?.recordId ?? null)
  ) {
    dispatch({ type: "customerAutoMatched", customer: autoMatch });
  }

  useAsyncMirrorMatch(args);
  useRefreshOnNoMatch(args, autoMatch, emailDomainPart);

  return {
    emailDomainPart,
    autoMatchedCustomer: autoMatch,
    isSearching: directory.status === "loading",
  };
}
