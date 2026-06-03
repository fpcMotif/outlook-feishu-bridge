import type { SVGProps } from "react";

/** Frame with ridge + sun — simplified photo silhouette. */
export function ImageFileIcon({
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
      <rect x="5.5" y="7" width="13" height="10" rx="1.75" />
      <path d="M8.25 15 11.5 12.25 14.25 15 18 12" />
      <circle cx="16.25" cy="9.75" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}
