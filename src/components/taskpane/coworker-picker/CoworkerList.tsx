import type { Coworker } from "../coworkers";
import { CoworkerOption } from "./CoworkerOption";

// Renders the live search results. Each row is resolved through directoryById so
// a result carries the richest known projection (fixtures/recents/results merge).
export function CoworkerList({
  results,
  directoryById,
  selectedOpenId,
  onSelect,
}: {
  results: Coworker[];
  directoryById: Map<string, Coworker>;
  selectedOpenId?: string;
  onSelect: (coworker: Coworker) => void;
}) {
  if (results.length === 0) return null;
  return (
    <>
      {results.map((coworker) => (
        <CoworkerOption
          key={coworker.openId}
          coworker={directoryById.get(coworker.openId) ?? coworker}
          selected={selectedOpenId === coworker.openId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
