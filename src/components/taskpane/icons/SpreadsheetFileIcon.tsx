import type { SVGProps } from "react";

/** Four-cell grid — Excel-style, minimal at small sizes. */
export function SpreadsheetFileIcon({
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
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M6 11h12M12 6v12" />
    </svg>
  );
}
