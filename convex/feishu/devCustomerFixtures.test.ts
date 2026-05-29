import { afterEach, describe, expect, it } from "vitest";

import {
  DEV_CUSTOMER_FIXTURES,
  isDevCustomerFixturesEnabled,
  searchDevCustomerFixtures,
  withDevCustomerFixtures,
} from "./devCustomerFixtures";

const originalDeployment = process.env.CONVEX_DEPLOYMENT;
const originalEnabled = process.env.ENABLE_DEV_CUSTOMER_FIXTURES;

afterEach(() => {
  if (originalDeployment === undefined) {
    delete process.env.CONVEX_DEPLOYMENT;
  } else {
    process.env.CONVEX_DEPLOYMENT = originalDeployment;
  }
  if (originalEnabled === undefined) {
    delete process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
  } else {
    process.env.ENABLE_DEV_CUSTOMER_FIXTURES = originalEnabled;
  }
});

describe("dev Customer fixtures", () => {
  it("enables the fanpc fixture on the configured dev deployment", () => {
    process.env.CONVEX_DEPLOYMENT = "dev:steady-setter-706";

    expect(isDevCustomerFixturesEnabled()).toBe(true);
    expect(DEV_CUSTOMER_FIXTURES[0]).toMatchObject({
      name: "fanpc",
      domain: "fenchem.com",
    });
  });

  it("prepends fanpc and lets the dev fixture override a live duplicate domain", () => {
    process.env.ENABLE_DEV_CUSTOMER_FIXTURES = "true";

    const records = withDevCustomerFixtures([
      { recordId: "rec_live", name: "Fenchem Live", domain: "fenchem.com", owner: null },
      { recordId: "rec_other", name: "Other", domain: "other.example", owner: null },
    ]);

    expect(records.map((record) => record.name)).toEqual(["fanpc", "Other"]);
  });

  it("finds the fanpc fixture by customer name or domain", () => {
    process.env.ENABLE_DEV_CUSTOMER_FIXTURES = "true";

    expect(searchDevCustomerFixtures("fanpc")).toHaveLength(1);
    expect(searchDevCustomerFixtures("fenchem.com")).toHaveLength(1);
  });
});
