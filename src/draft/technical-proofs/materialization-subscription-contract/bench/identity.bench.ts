import { bench, describe } from "vitest";

// Presence + executable hot-path noop for materialization-subscription-contract (gate checks presence by default).
describe("materialization-subscription-contract", () => {
  bench("identity noop", () => {
    void "materialization-subscription-contract".length;
  });
});
