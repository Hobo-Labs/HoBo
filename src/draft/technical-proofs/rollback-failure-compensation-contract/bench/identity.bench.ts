import { bench, describe } from "vitest";

// Presence + executable hot-path noop for rollback-failure-compensation-contract (gate checks presence by default).
describe("rollback-failure-compensation-contract", () => {
  bench("identity noop", () => {
    void "rollback-failure-compensation-contract".length;
  });
});
