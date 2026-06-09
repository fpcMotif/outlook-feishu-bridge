import type { SVGProps } from "react";

/** Minimal line-art trash can — bucket, lid, and small handle. */
export function TrashIcon({
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
      <path d="M10.25 4.25h3.5" />
      <path d="M6.25 7.5h11.5" />
      <path d="M8 7.5l.85 12.25h6.3L16 7.5" />
      <path d="M10.25 11.25v5.25" />
      <path d="M13.75 11.25v5.25" />
    </svg>
  );
}
