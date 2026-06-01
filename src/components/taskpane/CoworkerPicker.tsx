import type * as React from "react";

import type { Coworker } from "./coworkers";
import { TaskpaneSection } from "./TaskpaneSection";
import { ClientInfo } from "./coworker-picker/ClientInfo";
import { CoworkerList } from "./coworker-picker/CoworkerList";
import { CoworkerSearchSection } from "./coworker-picker/CoworkerSearchSection";
import { SelectedCoworkerCard } from "./coworker-picker/SelectedCoworkerCard";
import { useCoworkerList } from "./coworker-picker/useCoworkerList";

export function CoworkerPicker({
  clientEmail,
  onClientEmailChange,
  customerSlot,
  sessionId,
  userAccessToken,
  selectedOpenId,
  onSelect,
  usePreviewCoworkers = false,
}: {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
  customerSlot?: React.ReactNode;
  sessionId: string;
  userAccessToken?: string;
  selectedOpenId?: string;
  onSelect: (coworker: Coworker) => void;
  usePreviewCoworkers?: boolean;
}) {
  const { query, setQuery, results, directoryById, searching, selectedCoworker, handleSelect } =
    useCoworkerList({ sessionId, userAccessToken, usePreviewCoworkers, selectedOpenId, onSelect });

  return (
    <TaskpaneSection id="client-coworker-title" title="Customer & coworker">
      <section className="bg-card-soft overflow-visible rounded-xl shadow-edge">
        <ClientInfo clientEmail={clientEmail} onClientEmailChange={onClientEmailChange} />
        {customerSlot ? <div className="border-border border-t">{customerSlot}</div> : null}
      </section>

      <CoworkerSearchSection query={query} onQueryChange={setQuery} open={searching}>
        <CoworkerList
          results={results}
          directoryById={directoryById}
          selectedOpenId={selectedOpenId}
          onSelect={handleSelect}
        />
      </CoworkerSearchSection>

      {!searching && selectedCoworker ? <SelectedCoworkerCard coworker={selectedCoworker} /> : null}
    </TaskpaneSection>
  );
}
