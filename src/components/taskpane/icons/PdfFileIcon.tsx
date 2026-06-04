import type { SVGProps } from "react";

/** Folded page with filled dog-ear — PDF at 20px, no letterforms. */
export function PdfFileIcon({
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
      <path d="M7 5.5h6.5L17 9v9.5H7z" />
      <path d="M13.5 5.5V9H17" />
      <path
        d="M13.5 5.5 17 9 13.5 9z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
