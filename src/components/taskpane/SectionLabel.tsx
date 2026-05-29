export function SectionLabel({ id, children }: { id?: string; children: string }) {
  return (
    <div
      id={id}
      className="text-accent-foreground flex items-center gap-2 text-[11px] font-semibold uppercase"
    >
      <span aria-hidden="true" className="h-px w-3.5 shrink-0 bg-current opacity-55" />
      {children}
    </div>
  );
}
