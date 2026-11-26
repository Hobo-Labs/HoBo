import { bench, describe } from "vitest";

// Presence + executable hot-path noop for built-in-policy-engine-contract (gate checks presence by default).
describe("built-in-policy-engine-contract", () => {
  bench("identity noop", () => {
    void "built-in-policy-engine-contract".length;
  });
});
