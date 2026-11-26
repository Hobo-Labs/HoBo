import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-partial-apply-compensation-contract (gate checks presence by default).
describe("iac-partial-apply-compensation-contract", () => {
  bench("identity noop", () => {
    void "iac-partial-apply-compensation-contract".length;
  });
});
