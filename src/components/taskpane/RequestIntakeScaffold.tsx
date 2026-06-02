import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { RequestCards } from "./RequestCards";
import { TaskpaneSection } from "./TaskpaneSection";

const CREATE_CUSTOMER_MOCK_URL = "https://example.com/";

export function buildCreateCustomerTaskUrl(customerName: string) {
  const url = new URL(CREATE_CUSTOMER_MOCK_URL);
  url.searchParams.set("task", "create-customer");
  url.searchParams.set("name", customerName);
  return url.toString();
}

// Intake page header (ADR-0020 second-pass UI). Hosts the profile slot inline on
// the right so the logged-in account controls + theme toggle ride the header row.
export function IntakeHeader({ profileSlot }: { profileSlot?: ReactNode }) {
  return (
    <header className="intake-stagger flex items-center justify-between gap-3 px-1 pt-3 pb-8">
      <h1 className="sync-enter min-w-0 flex-1 text-[34px] leading-[0.98] tracking-tight text-balance">
        Sales Services
      </h1>
      {profileSlot ? <div>{profileSlot}</div> : null}
    </header>
  );
}

export function ExistingSyncCheckingScreen() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" aria-label="Checking Feishu record" />
      <p className="text-muted-foreground text-sm">Checking Feishu record...</p>
    </div>
  );
}

export function NewRequestSection({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <TaskpaneSection id="new-request-title" title="New request">
      <RequestCards values={values} onChange={onChange} />
    </TaskpaneSection>
  );
}
