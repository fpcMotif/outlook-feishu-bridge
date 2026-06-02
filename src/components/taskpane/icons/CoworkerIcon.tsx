import type { SVGProps } from "react";

/** Front-facing colleague with a coffee mug — coworker fallback (distinct from UserRound). */
export function CoworkerIcon({
  className,
  strokeWidth = 2,
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
      <circle cx="10" cy="7.5" r="2.25" />
      <path d="M6.5 12.25c0-1.65 1.65-2.75 3.5-2.75s3.5 1.1 3.5 2.75" />
      <path d="M12.75 10l2.25 2" />
      <path d="M15 9.25h4" />
      <path d="M15 9.25v3.75a1.75 1.75 0 0 0 3.5 0V9.25" />
      <path d="M18.25 10.25h.9a1.1 1.1 0 0 1 0 2.2h-.9" />
      <path d="M16.25 6.75v.75M18.25 6.5v1" />
    </svg>
  );
}
