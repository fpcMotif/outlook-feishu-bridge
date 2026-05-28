import * as React from "react";
import type { Coworker } from "../coworkers";
import { CoworkerOption } from "./CoworkerOption";

export function CoworkerList({
  list,
  listLabel,
  searching,
  query,
  selectedOpenId,
  directoryById,
  onSelect,
}: {
  list: Coworker[];
  listLabel: string;
  searching: boolean;
  query: string;
  selectedOpenId?: string;
  directoryById: Map<string, Coworker>;
  onSelect: (coworker: Coworker) => void;
}) {
  return (
    <>
      <div className="text-muted-foreground mt-4 mb-2 px-1 text-[11px] font-semibold tracking-wide uppercase">
        {listLabel}
      </div>
      <div className="space-y-2">
        {list.length > 0 ? (
          list.map((coworker) => (
            <CoworkerOption
              key={coworker.openId}
              coworker={directoryById.get(coworker.openId) ?? coworker}
              selected={selectedOpenId === coworker.openId}
              onSelect={onSelect}
            />
          ))
        ) : (
          <p className="text-muted-foreground px-1 py-2 text-sm">
            {searching ? `No coworkers match "${query}"` : "Search for a Feishu coworker"}
          </p>
        )}
      </div>
    </>
  );
}
