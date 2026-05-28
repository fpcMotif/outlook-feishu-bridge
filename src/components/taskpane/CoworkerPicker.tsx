import * as React from "react";
import { ArrowLeft } from "lucide-react";

import type { Coworker } from "./coworkers";
import type { Contact } from "@/forward/targets";
import {
  ClientInfo,
  CoworkerSearchSection,
  useCoworkerList,
  CoworkerList,
} from "./coworker-picker";

export type SearchCoworkers = (query: string) => Promise<Contact[]>;

export interface CoworkerPickerProps {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
  customerSlot?: React.ReactNode;
  sessionId: string;
  userAccessToken?: string;
  selectedOpenId?: string;
  onSelect: (coworker: Coworker) => void;
  onBack: () => void;
}

function PickerHeader({ onBack }: { onBack: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-primary mb-3 inline-flex min-h-10 items-center gap-2 text-xs font-semibold transition-[color] duration-150"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>
      <header className="px-1 pb-2">
        <div className="text-accent-foreground mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Client &amp; coworker
        </div>
      </header>
    </>
  );
}

export function CoworkerPicker(props: CoworkerPickerProps) {
  const {
    query,
    setQuery,
    focused,
    setFocused,
    list,
    listLabel,
    searching,
    directoryById,
    handleSelect,
  } = useCoworkerList(props.sessionId, props.userAccessToken);

  return (
    <div className="no-scrollbar flex-1 overflow-y-auto px-5 pt-3 pb-2">
      <PickerHeader onBack={props.onBack} />
      <ClientInfo
        clientEmail={props.clientEmail}
        onClientEmailChange={props.onClientEmailChange}
      />
      {props.customerSlot ? <div className="mt-3">{props.customerSlot}</div> : null}

      <CoworkerSearchSection
        query={query}
        focused={focused}
        onQueryChange={setQuery}
        onFocusChange={setFocused}
      />

      <CoworkerList
        list={list}
        listLabel={listLabel}
        searching={searching}
        query={query}
        selectedOpenId={props.selectedOpenId}
        directoryById={directoryById}
        onSelect={(c) => handleSelect(c, props.onSelect)}
      />
    </div>
  );
}
