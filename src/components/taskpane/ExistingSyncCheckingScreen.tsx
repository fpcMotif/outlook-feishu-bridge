import { Loader2 } from "lucide-react";

export function ExistingSyncCheckingScreen() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" aria-label="Checking Feishu record" />
      <p className="text-muted-foreground text-sm">Checking Feishu record…</p>
    </div>
  );
}
