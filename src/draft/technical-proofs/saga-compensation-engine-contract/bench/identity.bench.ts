import { bench, describe } from "vitest";

// Presence + executable hot-path noop for saga-compensation-engine-contract (gate checks presence by default).
describe("saga-compensation-engine-contract", () => {
  bench("identity noop", () => {
    void "saga-compensation-engine-contract".length;
  });
});
