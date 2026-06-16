import { TaskpaneSection } from "@/design-system/taskpane";

import { RequestCards } from "./RequestCards";

export function NewRequestSection({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <TaskpaneSection id="new-request-title" title="Request">
      <RequestCards values={values} onChange={onChange} />
    </TaskpaneSection>
  );
}
