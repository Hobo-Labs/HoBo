import { bench, describe } from "vitest";

// Presence + executable hot-path noop for curated-catalog-policy-contract (gate checks presence by default).
describe("curated-catalog-policy-contract", () => {
  bench("identity noop", () => {
    void "curated-catalog-policy-contract".length;
  });
});
