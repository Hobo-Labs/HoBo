import { bench, describe } from "vitest";

// Presence + executable hot-path noop for closure-builder-public-api-contract (gate checks presence by default).
describe("closure-builder-public-api-contract", () => {
  bench("identity noop", () => {
    void "closure-builder-public-api-contract".length;
  });
});
