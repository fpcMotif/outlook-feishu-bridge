export function SectionLabel({ id, children }: { id?: string; children: string }) {
  return (
    <div
      id={id}
      className="text-accent-foreground flex h-5 items-center gap-2 text-[15px] leading-none font-semibold tracking-[0.01em] uppercase"
    >
      <span aria-hidden="true" className="h-px w-4 shrink-0 bg-current opacity-55" />
      <span>{children}</span>
    </div>
  );
}
