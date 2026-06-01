import { describe, expect, it } from "vitest";

import { filterLocalCustomers } from "./customerSearchHelpers";
import type { CustomerRecord } from "./customers";

function matchingCustomer(index: number, onReadName: () => void): CustomerRecord {
  return {
    recordId: `rec_${index}`,
    get name() {
      onReadName();
      return `Acme ${index}`;
    },
    owner: null,
  };
}

describe("customerSearchHelpers", () => {
  it("stops local filtering once the display limit is full", () => {
    let nameReads = 0;
    const records = Array.from({ length: 100 }, (_, index) =>
      matchingCustomer(index, () => {
        nameReads += 1;
      }),
    );

    const matches = filterLocalCustomers(records, "acme", false, undefined, 8);

    expect(matches).toHaveLength(8);
    expect(nameReads).toBe(8);
  });
});
