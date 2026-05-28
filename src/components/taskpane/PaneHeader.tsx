import { FeishuProfile } from "./FeishuProfile";

interface FeishuUser {
  openId: string;
  userName?: string;
  avatarUrl?: string;
  email?: string;
  org?: string;
}

function BridgeLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-full" aria-hidden="true">
      <rect x="3" y="5" width="14" height="14" rx="3" fill="var(--primary)" />
      <path
        d="M6 9h8M6 12h8M6 15h5"
        stroke="var(--primary-foreground)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="m13 16 7 5V3l-7 5" fill="var(--foreground)" />
    </svg>
  );
}

export function PaneHeader({
  user,
  onLogout,
}: {
  user: FeishuUser;
  onLogout: () => void;
}) {
  return (
    <header className="bg-card flex h-12 shrink-0 items-center justify-between border-b pr-2.5 pl-3.5">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-[26px] items-center justify-center">
          <BridgeLogo />
        </span>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-[-0.005em]">feishu-sync</div>
          <div className="text-muted-foreground mt-px text-[10.5px]">Sync requests in one tap</div>
        </div>
      </div>

      <div className="flex items-center">
        <FeishuProfile user={user} onLogout={onLogout} />
      </div>
    </header>
  );
}
