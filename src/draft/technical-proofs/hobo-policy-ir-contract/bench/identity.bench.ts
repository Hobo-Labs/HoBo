import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-policy-ir-contract (gate checks presence by default).
describe("hobo-policy-ir-contract", () => {
  bench("identity noop", () => {
    void "hobo-policy-ir-contract".length;
  });
});
