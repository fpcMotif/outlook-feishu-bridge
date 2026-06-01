import { Loader2 } from "lucide-react";

import { RequestCards } from "./RequestCards";
import { REQUESTS } from "./requests";
import { TaskpaneSection } from "./TaskpaneSection";

const CREATE_CUSTOMER_MOCK_URL = "https://example.com/";

export function buildCreateCustomerTaskUrl(customerName: string) {
  const url = new URL(CREATE_CUSTOMER_MOCK_URL);
  url.searchParams.set("task", "create-customer");
  url.searchParams.set("name", customerName);
  return url.toString();
}

export function buildFilledRequests(notes: Record<string, string>) {
  return REQUESTS.flatMap((r) => {
    const note = (notes[r.id] ?? "").trim();
    return note ? [{ id: r.id, title: r.title, note }] : [];
  });
}

export function Hero() {
  return (
    <header className="px-1 pt-3 pb-5">
      <h1 className="text-[34px] leading-[0.98] tracking-tight">
        Sales Services
      </h1>
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
