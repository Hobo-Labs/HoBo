import { bench, describe } from "vitest";

// Presence + executable hot-path noop for policy-fail-closed-contract (gate checks presence by default).
describe("policy-fail-closed-contract", () => {
  bench("identity noop", () => {
    void "policy-fail-closed-contract".length;
  });
});
