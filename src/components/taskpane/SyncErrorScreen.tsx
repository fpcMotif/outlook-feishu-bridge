import { Button } from "../ui/button";

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
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-2xl">Sync failed</h1>
      <p className="text-muted-foreground max-w-[34ch] text-sm leading-relaxed">{message}</p>
      <div className="flex gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
