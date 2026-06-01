import { Button } from "@/components/ui/button";

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

function FeishuGlyph({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} fill="currentColor" aria-hidden="true">
      <path d="M4.2 18.6c5 .6 9.3-1.5 12.2-6 .2 2.2-.4 4.3-1.7 6 3-.1 5.7-1.6 7.9-4.5.1 4.1-2.6 7.5-6.9 8.8-4.4 1.3-8.9-.3-11.5-4.3Z" />
      <circle cx="20" cy="8.6" r="2.1" />
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
        className="bg-primary text-primary-foreground flex size-14 items-center justify-center rounded-xl shadow-edge"
      >
        <FeishuGlyph className="size-7" />
      </span>
    </div>
  );
}

export function ConnectCard({
  onLogin,
  onLoginFallback,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  return (
    <section
      aria-label="Feishu sign in"
      className="bg-card mx-auto flex aspect-square w-full max-w-[420px] flex-col justify-center rounded-[28px] p-6 shadow-float"
    >
      <ConnectVisual />
      <div className="mt-6 flex flex-col gap-2">
        <Button className="h-11 w-full rounded-[14px]" onClick={onLogin}>
          <FeishuGlyph className="size-4" />
          <span>Continue with Feishu</span>
        </Button>
        <button
          type="button"
          onClick={onLoginFallback}
          className="text-muted-foreground hover:text-primary inline-flex min-h-10 items-center justify-center text-xs font-medium underline-offset-2 transition-[color,scale] duration-150 ease-[var(--ease-out-strong)] hover:underline active:scale-[0.97]"
        >
          Use backup login (email code)
        </button>
      </div>
    </section>
  );
}
