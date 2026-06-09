import type { SVGProps } from "react";

/** Plain file tab — neutral fallback with no interior detail. */
export function GenericFileIcon({
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
      <path d="M8 4.5h5.5L17 8v11.5H8z" />
      <path d="M13.5 4.5V8H17" />
    </svg>
  );
}
