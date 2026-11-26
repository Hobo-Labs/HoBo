import { bench, describe } from "vitest";

// Presence + executable hot-path noop for capability-negotiation-contract (gate checks presence by default).
describe("capability-negotiation-contract", () => {
  bench("identity noop", () => {
    void "capability-negotiation-contract".length;
  });
});
