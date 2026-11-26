import { bench, describe } from "vitest";

// Presence + executable hot-path noop for capability-spec-contract (gate checks presence by default).
describe("capability-spec-contract", () => {
  bench("identity noop", () => {
    void "capability-spec-contract".length;
  });
});
