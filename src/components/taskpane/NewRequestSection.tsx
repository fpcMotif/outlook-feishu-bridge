import { RequestCards } from "./RequestCards";
import { TaskpaneSection } from "./TaskpaneSection";

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
