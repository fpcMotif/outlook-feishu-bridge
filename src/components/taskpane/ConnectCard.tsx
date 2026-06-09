import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { FeishuLogo } from "./FeishuLogo";

type ConnectActionsProps = {
  onLogin: () => void;
  onLoginFallback: () => void;
  isCheckingSession: boolean;
};

function OutlookLogo() {
  return (
    <svg viewBox="0 0 28 28" className="size-7" aria-hidden="true">
      <rect x="11" y="7.5" width="14.5" height="13" rx="1.6" fill="#0f6cbd" />
      <path
        d="M11.8 9.6l6.45 4.3 6.45-4.3"
        fill="none"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect x="2.5" y="5.5" width="11.5" height="17" rx="2.4" fill="#0a4c92" />
      <ellipse cx="8.25" cy="14" rx="2.6" ry="3.3" fill="none" stroke="#fff" strokeWidth="1.8" />
    </svg>
  );
}

function ConnectVisual() {
  return (
    <div className="bg-card-soft flex items-center justify-center gap-4 rounded-[20px] py-8 shadow-edge">
      <span
        aria-hidden="true"
        className="bg-card flex size-14 items-center justify-center rounded-xl shadow-edge"
      >
        <OutlookLogo />
      </span>
      <span className="flex items-center gap-1.5" aria-hidden="true">
        <span className="bg-border size-1 rounded-full" />
        <span className="bg-border size-1 rounded-full" />
        <span className="bg-border size-1 rounded-full" />
      </span>
      <span
        aria-hidden="true"
        className="bg-card flex size-14 items-center justify-center rounded-xl p-2 shadow-edge"
      >
        <FeishuLogo className="size-9" />
      </span>
    </div>
  );
}

function BackupLoginButton({
  disabled,
  onLoginFallback,
}: {
  disabled: boolean;
  onLoginFallback: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onLoginFallback}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-10 items-center justify-center text-xs font-medium underline-offset-2 transition-[color,scale] duration-150 ease-[var(--ease-out-strong)]",
        "disabled:cursor-not-allowed disabled:text-muted-foreground/55 disabled:hover:no-underline disabled:active:scale-100",
        disabled
          ? "text-muted-foreground/55"
          : "text-muted-foreground hover:text-primary hover:underline active:scale-[0.97]",
      )}
    >
      Use backup login (email code)
    </button>
  );
}

function ConnectActions({
  onLogin,
  onLoginFallback,
  isCheckingSession,
}: ConnectActionsProps) {
  return (
    <div className="mt-5 flex flex-col gap-2">
      <Button
        className="h-11 w-full rounded-[14px] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
        onClick={onLogin}
        disabled={isCheckingSession}
        aria-busy={isCheckingSession}
      >
        {isCheckingSession ? (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            <output aria-live="polite">Checking Feishu&hellip;</output>
          </>
        ) : (
          <>
            <FeishuLogo className="size-4 shrink-0" />
            <span>Continue with Feishu</span>
          </>
        )}
      </Button>
      <BackupLoginButton disabled={isCheckingSession} onLoginFallback={onLoginFallback} />
    </div>
  );
}

export function ConnectCard({
  onLogin,
  onLoginFallback,
  isCheckingSession = false,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
  isCheckingSession?: boolean;
}) {
  return (
    <section
      aria-label="Feishu sign in"
      className="bg-card mx-auto flex aspect-square w-full max-w-[420px] flex-col justify-center rounded-[28px] p-6 shadow-float"
    >
      <ConnectVisual />
      <p className="text-muted-foreground mt-5 text-center text-sm leading-relaxed text-pretty">
        Sync this email into your team&apos;s Services Base.
      </p>
      <ConnectActions
        onLogin={onLogin}
        onLoginFallback={onLoginFallback}
        isCheckingSession={isCheckingSession}
      />
    </section>
  );
}
