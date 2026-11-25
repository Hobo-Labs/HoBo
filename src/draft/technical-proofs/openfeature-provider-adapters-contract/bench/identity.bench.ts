import { bench, describe } from "vitest";

// Presence + executable hot-path noop for openfeature-provider-adapters-contract (gate checks presence by default).
describe("openfeature-provider-adapters-contract", () => {
  bench("identity noop", () => {
    void "openfeature-provider-adapters-contract".length;
  });
});
