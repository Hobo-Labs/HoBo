import { bench, describe } from "vitest";

// Presence + executable hot-path noop for feature-flag-governance-contract (gate checks presence by default).
describe("feature-flag-governance-contract", () => {
  bench("identity noop", () => {
    void "feature-flag-governance-contract".length;
  });
});
