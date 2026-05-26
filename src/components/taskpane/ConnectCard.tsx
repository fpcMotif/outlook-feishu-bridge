import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ConnectCard({
  onLogin,
  onLoginFallback,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  return (
    <div className="bg-card-soft rounded-2xl border border-dashed p-4">
      <div className="flex items-start gap-3">
        <span className="bg-secondary text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
          <LogIn className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Connect your Feishu account</div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            Message colleagues &amp; groups and forward as yourself. Bot &amp; Bitable work without
            it.
          </p>
          <div className="mt-2.5 flex items-center gap-3">
            <Button size="sm" onClick={onLogin}>
              Log in to Feishu
            </Button>
            <button
              type="button"
              onClick={onLoginFallback}
              className="text-muted-foreground hover:text-primary text-xs underline-offset-2 hover:underline"
            >
              Use backup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
