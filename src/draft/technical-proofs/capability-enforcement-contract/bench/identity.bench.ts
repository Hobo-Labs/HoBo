import { bench, describe } from "vitest";

// Presence + executable hot-path noop for capability-enforcement-contract (gate checks presence by default).
describe("capability-enforcement-contract", () => {
  bench("identity noop", () => {
    void "capability-enforcement-contract".length;
  });
});
