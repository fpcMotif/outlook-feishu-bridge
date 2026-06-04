import { Moon, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { applyTheme, persistTheme, readTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const iconTransition =
  "transition-[opacity,transform,filter] duration-300 ease-[var(--ease-out-strong)] motion-reduce:transition-none motion-reduce:blur-0";

function ThemeIcon({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        iconTransition,
        active ? "scale-100 opacity-100 blur-0" : "pointer-events-none scale-[0.25] opacity-0 blur-[4px]",
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}

/** User-facing light/dark switch (ADR-0020). Mounted in the logged-in profile header. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const dark = theme === "dark";

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = () => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      persistTheme(next);
      return next;
    });
  };

  return (
    <button
      id="theme-toggle"
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
      className={cn(
        "focus-visible:ring-ring/20 relative inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full",
        "text-muted-foreground outline-none transition-[color,scale] duration-150 ease-[var(--ease-out-strong)]",
        "hover:text-foreground active:scale-[0.96] focus-visible:ring-[3px]",
      )}
    >
      <span className="relative size-4 shrink-0">
        <ThemeIcon active={!dark}>
          <Sun className="size-4" strokeWidth={2.25} />
        </ThemeIcon>
        <ThemeIcon active={dark}>
          <Moon className="size-4" strokeWidth={2.25} />
        </ThemeIcon>
      </span>
    </button>
  );
}
