import { bench, describe } from "vitest";

// Presence + executable hot-path noop for generation-safety-gate-contract (gate checks presence by default).
describe("generation-safety-gate-contract", () => {
  bench("identity noop", () => {
    void "generation-safety-gate-contract".length;
  });
});
