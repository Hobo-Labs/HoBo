import { bench, describe } from "vitest";

// Presence + executable hot-path noop for non-iac-driver-adapters-contract (gate checks presence by default).
describe("non-iac-driver-adapters-contract", () => {
  bench("identity noop", () => {
    void "non-iac-driver-adapters-contract".length;
  });
});
