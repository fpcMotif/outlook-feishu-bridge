import type { SVGProps } from "react";

/** Box with zipper teeth — compressed archive silhouette. */
export function ArchiveFileIcon({
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
      <path d="M8 8.5V6.75A1.25 1.25 0 0 1 9.25 5.5h5.5A1.25 1.25 0 0 1 16 6.75V8.5" />
      <path d="M6.5 8.5h11v10.25A1.25 1.25 0 0 1 16.25 20H7.75a1.25 1.25 0 0 1-1.25-1.25z" />
      <path d="M8.25 13h7.5" />
      <path d="M9.75 13v2.25" />
      <path d="M11.25 13v2.25" />
      <path d="M12.75 13v2.25" />
      <path d="M14.25 13v2.25" />
    </svg>
  );
}
