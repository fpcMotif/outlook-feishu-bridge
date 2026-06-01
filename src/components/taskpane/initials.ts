// Two-letter initials for an avatar fallback, shared by FeishuProfile and the
// CoworkerPicker so a missing/expired/slow avatar still renders an identifying
// glyph (ADR-0003 amendment). Pure + unit-tested per ADR-0019.
export function initials(name?: string): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "U";
}
