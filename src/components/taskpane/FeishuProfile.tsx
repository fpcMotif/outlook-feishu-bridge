/* eslint-disable max-lines-per-function */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface FeishuUser {
  openId: string;
  userName?: string;
  avatarUrl?: string;
  email?: string;
  org?: string;
}

function initials(name?: string): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "U";
}

export function FeishuProfile({ user, onLogout }: { user: FeishuUser; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-visible:ring-ring/30 relative inline-flex min-h-10 min-w-10 items-center justify-center rounded-full outline-none transition-[box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] focus-visible:ring-[3px]"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Feishu profile"
      >
        <Avatar className="size-8">
          {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
          <AvatarFallback className="bg-foreground text-background">
            {initials(user.userName)}
          </AvatarFallback>
        </Avatar>
        <span className="border-background bg-sage absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2" />
      </button>

      {open ? (
        <dialog
          open
          aria-label="Feishu account"
          className="bg-popover text-popover-foreground profile-pop absolute top-full right-0 z-50 mt-2 w-64 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border-0 p-0 shadow-[var(--shadow-floating)] backdrop:bg-transparent"
        >
          <div className="px-3.5 pt-3 pb-2.5">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{user.userName ?? "Feishu user"}</div>
              {user.email ? <div className="text-muted-foreground truncate text-xs">{user.email}</div> : null}
              <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                <span className="bg-sage size-1.5 shrink-0 rounded-full" />
                <span className="text-sage shrink-0 font-medium">Connected</span>
                {user.org ? <span className="text-muted-foreground min-w-0 truncate">{user.org}</span> : null}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="text-destructive hover:bg-destructive/5 flex w-full items-center gap-2 border-t px-3.5 py-3 text-sm font-medium"
          >
            <X className="size-4" />
            Sign out of Feishu
          </button>
        </dialog>
      ) : null}
    </div>
  );
}
