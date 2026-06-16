import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

type HeadingTag = "h1" | "h2" | "h3";

function StateMessageIcon({
  icon,
  className,
}: {
  icon?: ReactNode;
  className?: string;
}) {
  if (!icon) return null;

  return (
    <span
      className={cn(
        "bg-card-soft text-muted-foreground mb-4 flex size-14 items-center justify-center rounded-2xl shadow-edge",
        className,
      )}
    >
      {icon}
    </span>
  );
}

function StateMessageDescription({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;

  return (
    <p
      className={cn(
        "text-muted-foreground mt-1.5 max-w-[34ch] text-sm leading-relaxed text-pretty",
        className,
      )}
    >
      {children}
    </p>
  );
}

function StateMessageActions({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;

  return (
    <div className={cn("mt-4 flex items-center justify-center gap-2", className)}>
      {children}
    </div>
  );
}

export function TaskpaneAppFrame({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("bg-background relative flex h-screen w-full flex-col overflow-hidden", className)}
      {...props}
    />
  );
}

export function TaskpaneMain({
  className,
  ...props
}: ComponentPropsWithoutRef<"main">) {
  return <main className={cn("flex min-h-0 flex-1 flex-col", className)} {...props} />;
}

export function TaskpaneScrollShell({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "bg-background text-foreground no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8",
        className,
      )}
      {...props}
    />
  );
}

export function TaskpaneEyebrow({
  children,
  className,
  ruleClassName,
}: {
  children: ReactNode;
  className?: string;
  ruleClassName?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em]",
        className,
      )}
    >
      <span className={cn("bg-muted-foreground inline-block h-px w-3.5", ruleClassName)} />
      {children}
    </div>
  );
}

export function TaskpaneStateMessage({
  title,
  description,
  icon,
  actions,
  titleAs = "h1",
  className,
  iconClassName,
  titleClassName,
  descriptionClassName,
  actionsClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  titleAs?: HeadingTag;
  className?: string;
  iconClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  actionsClassName?: string;
}) {
  const Heading = titleAs;

  return (
    <div
      className={cn(
        "animate-pop-in flex flex-1 flex-col items-center justify-center px-8 text-center",
        className,
      )}
    >
      <StateMessageIcon icon={icon} className={iconClassName} />
      <Heading
        className={cn("text-2xl font-semibold tracking-tight text-balance", titleClassName)}
      >
        {title}
      </Heading>
      <StateMessageDescription className={descriptionClassName}>
        {description}
      </StateMessageDescription>
      <StateMessageActions className={actionsClassName}>{actions}</StateMessageActions>
    </div>
  );
}

export function InlineActionButton({
  className,
  ...props
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-10 items-center justify-center text-xs font-medium underline-offset-2 transition-[color,scale] duration-150 ease-[var(--ease-out-strong)]",
        "text-muted-foreground hover:text-primary hover:underline active:scale-[0.97]",
        "disabled:cursor-not-allowed disabled:text-muted-foreground/55 disabled:hover:no-underline disabled:active:scale-100",
        className,
      )}
      {...props}
    />
  );
}

export { SubmitDock } from "@/components/taskpane/SubmitDock";
export { TaskpaneInsetDivider } from "@/components/taskpane/TaskpaneInsetDivider";
export { TaskpaneSearchDropdown } from "@/components/taskpane/TaskpaneSearchDropdown";
export { TaskpaneSearchField } from "@/components/taskpane/TaskpaneSearchField";
export { TaskpaneSection } from "@/components/taskpane/TaskpaneSection";
export { TaskpaneSelectionRow } from "@/components/taskpane/TaskpaneSelectionRow";
