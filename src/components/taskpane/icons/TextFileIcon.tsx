import type { SVGProps } from "react";

/** Folded document with a single text line — no generic multi-line slop. */
export function TextFileIcon({
  className,
  strokeWidth = 1.75,
  ...props
}: SVGProps<SVGSVGElement> & { strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M6 4.5h7l4 4v12H6z" />
      <path d="M13 4.5V8.5h4" />
      <path d="M8.5 13h7" />
    </svg>
  );
}
