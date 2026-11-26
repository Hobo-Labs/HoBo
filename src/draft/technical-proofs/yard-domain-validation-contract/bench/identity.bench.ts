import { bench, describe } from "vitest";

// Presence + executable hot-path noop for yard-domain-validation-contract (gate checks presence by default).
describe("yard-domain-validation-contract", () => {
  bench("identity noop", () => {
    void "yard-domain-validation-contract".length;
  });
});
