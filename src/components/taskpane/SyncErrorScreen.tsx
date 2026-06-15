import { Button } from "@/design-system";
import { TaskpaneStateMessage } from "@/design-system/taskpane";

export function SyncErrorScreen({
  message,
  onRetry,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <TaskpaneStateMessage
      title="Sync failed"
      description={message}
      actions={
        <>
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        </>
      }
    />
  );
}
