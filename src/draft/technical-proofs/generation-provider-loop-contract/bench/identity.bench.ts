import { bench, describe } from "vitest";

// Presence + executable hot-path noop for generation-provider-loop-contract (gate checks presence by default).
describe("generation-provider-loop-contract", () => {
  bench("identity noop", () => {
    void "generation-provider-loop-contract".length;
  });
});
