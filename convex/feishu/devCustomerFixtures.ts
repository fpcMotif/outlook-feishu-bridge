import type { CustomerRecord } from "./customers";

// Dirty dev-only Customer fixtures. These are intentionally NOT Feishu
// Bitable rows: they exist so the dev deployment can exercise the same
// domain-matching path as production data without editing the live Customer
// table. They must only be exposed from Convex dev deployments.
export const DEV_CUSTOMER_FIXTURES: CustomerRecord[] = [
  {
    recordId: "dev_fixture_fanpc_customer",
    name: "fanpc",
    domain: "fenchem.com",
    fullName: "fanpc dev customer",
    accountNo: "DEV-FANPC",
    countryRegion: "Dev",
    owner: { openId: "ou_dev", name: "fanpc" },
  },
  {
    recordId: "dev_fixture_microsoft_customer",
    name: "Microsoft",
    domain: "microsoft.com",
    fullName: "Microsoft dev customer",
    accountNo: "DEV-MICROSOFT",
    countryRegion: "Dev",
    owner: null,
  },
];

// Dev-fixture record ids are stand-ins (e.g. "dev_fixture_fanpc_customer"),
// NOT real Customer-Table records. Writing one into the Service row's `Client`
// DuplexLink produces a dangling "?????" link in Bitable (the id resolves to
// nothing — Feishu 1254043 RecordIdNotFound). Callers use this to drop them
// before a write. Always returns false for real `rec…` ids.
const DEV_FIXTURE_RECORD_IDS: ReadonlySet<string> = new Set(
  DEV_CUSTOMER_FIXTURES.map((customer) => customer.recordId),
);

export function isDevFixtureRecordId(recordId: string | undefined | null): boolean {
  if (!recordId) return false;
  return DEV_FIXTURE_RECORD_IDS.has(recordId);
}

export function isDevCustomerFixturesEnabled(): boolean {
  // Gate fixtures to DEV only. Matching the bare deployment name (e.g.
  // "steady-setter-706") used to enable them on prod too (prod:steady-setter-706),
  // injecting phantom rows into the prod Customer Mirror — see ADR-0016.
  const deployment = process.env.CONVEX_DEPLOYMENT ?? "";
  return (
    process.env.ENABLE_DEV_CUSTOMER_FIXTURES === "true" || deployment.startsWith("dev:")
  );
}

export function mergePreferredCustomers(
  preferred: readonly CustomerRecord[],
  records: readonly CustomerRecord[],
): CustomerRecord[] {
  const preferredIds = new Set(preferred.map((customer) => customer.recordId));
  const preferredDomains = new Set(
    preferred.flatMap((customer) => {
      const domain = customer.domain?.trim().toLowerCase();
      return domain ? [domain] : [];
    }),
  );
  return [
    ...preferred,
    ...records.filter((customer) => {
      if (preferredIds.has(customer.recordId)) return false;
      const domain = customer.domain?.trim().toLowerCase();
      return domain === undefined || !preferredDomains.has(domain);
    }),
  ];
}

export function withDevCustomerFixtures(records: readonly CustomerRecord[]): CustomerRecord[] {
  return isDevCustomerFixturesEnabled()
    ? mergePreferredCustomers(DEV_CUSTOMER_FIXTURES, records)
    : [...records];
}

export function searchDevCustomerFixtures(
  query: string,
  mineFor?: string,
): CustomerRecord[] {
  if (!isDevCustomerFixturesEnabled()) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return DEV_CUSTOMER_FIXTURES.filter((customer) => {
    if (mineFor !== undefined && customer.owner?.openId !== mineFor) return false;
    return [
      customer.name,
      customer.fullName ?? "",
      customer.accountNo ?? "",
      customer.domain ?? "",
      customer.countryRegion ?? "",
      customer.owner?.name ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}
