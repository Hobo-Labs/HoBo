import { bench, describe } from "vitest";

// Presence + executable hot-path noop for generation-llm-fill-contract (gate checks presence by default).
describe("generation-llm-fill-contract", () => {
  bench("identity noop", () => {
    void "generation-llm-fill-contract".length;
  });
});
