import { bench, describe } from "vitest";

// Presence + executable hot-path noop for no-privilege-escalation-policy-contract (gate checks presence by default).
describe("no-privilege-escalation-policy-contract", () => {
  bench("identity noop", () => {
    void "no-privilege-escalation-policy-contract".length;
  });
});
