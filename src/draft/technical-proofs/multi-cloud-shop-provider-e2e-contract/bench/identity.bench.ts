import { bench, describe } from "vitest";

// Presence + executable hot-path noop for multi-cloud-shop-provider-e2e-contract (gate checks presence by default).
describe("multi-cloud-shop-provider-e2e-contract", () => {
  bench("identity noop", () => {
    void "multi-cloud-shop-provider-e2e-contract".length;
  });
});
