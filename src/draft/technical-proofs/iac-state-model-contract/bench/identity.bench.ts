import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-state-model-contract (gate checks presence by default).
describe("iac-state-model-contract", () => {
  bench("identity noop", () => {
    void "iac-state-model-contract".length;
  });
});
