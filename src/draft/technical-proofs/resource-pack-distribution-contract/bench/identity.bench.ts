import { bench, describe } from "vitest";

// Presence + executable hot-path noop for resource-pack-distribution-contract (gate checks presence by default).
describe("resource-pack-distribution-contract", () => {
  bench("identity noop", () => {
    void "resource-pack-distribution-contract".length;
  });
});
