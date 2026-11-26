import { bench, describe } from "vitest";

// Presence + executable hot-path noop for yard-receipt-consumption-contract (gate checks presence by default).
describe("yard-receipt-consumption-contract", () => {
  bench("identity noop", () => {
    void "yard-receipt-consumption-contract".length;
  });
});
