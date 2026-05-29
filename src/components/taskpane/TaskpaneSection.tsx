import type { ReactNode } from "react";

import { SectionLabel } from "./SectionLabel";

export function TaskpaneSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <header className="px-1">
        <SectionLabel id={id}>{title}</SectionLabel>
      </header>
      {children}
    </section>
  );
}
