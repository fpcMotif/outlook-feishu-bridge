import { Loader2 } from "lucide-react";

export function AuthResolvingScreen() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" aria-label="Checking Feishu session" />
    </div>
  );
}
