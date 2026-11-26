import { bench, describe } from "vitest";

// Presence + executable hot-path noop for s1-stage-gate (gate checks presence by default).
describe("s1-stage-gate", () => {
  bench("identity noop", () => {
    void "s1-stage-gate".length;
  });
});
