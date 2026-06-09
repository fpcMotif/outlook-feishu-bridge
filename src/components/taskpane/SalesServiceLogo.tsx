export function SalesServiceLogo({ className = "size-6" }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/fenchem_logo.png`}
      alt="Sales Service logo"
      className={className}
    />
  );
}
