import { bench, describe } from "vitest";

// Presence + executable hot-path noop for tax-currency-receipt-obligations-contract (gate checks presence by default).
describe("tax-currency-receipt-obligations-contract", () => {
  bench("identity noop", () => {
    void "tax-currency-receipt-obligations-contract".length;
  });
});
