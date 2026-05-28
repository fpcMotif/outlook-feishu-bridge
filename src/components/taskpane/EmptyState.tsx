import { Loader2, MailOpen } from "lucide-react";
import { Button } from "../ui/button";

export function EmptyState({
  loading,
  error,
  onRead,
}: {
  loading: boolean;
  error: string | null;
  onRead: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <span className="bg-secondary text-muted-foreground mb-4 flex size-14 items-center justify-center rounded-2xl">
        {loading ? <Loader2 className="size-6 animate-spin" /> : <MailOpen className="size-6" />}
      </span>
      <h2 className="font-serif text-2xl">{loading ? "Reading your email..." : "No message open"}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-[32ch] text-sm leading-relaxed">
        {error ?? "Open a received message in Outlook, then sync it to Feishu from here."}
      </p>
      {loading ? null : (
        <Button variant="secondary" className="mt-4" onClick={onRead}>
          Read current email
        </Button>
      )}
    </div>
  );
}
