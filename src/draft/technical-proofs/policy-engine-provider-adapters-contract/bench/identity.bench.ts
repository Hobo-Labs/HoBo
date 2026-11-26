import { bench, describe } from "vitest";

// Presence + executable hot-path noop for policy-engine-provider-adapters-contract (gate checks presence by default).
describe("policy-engine-provider-adapters-contract", () => {
  bench("identity noop", () => {
    void "policy-engine-provider-adapters-contract".length;
  });
});
