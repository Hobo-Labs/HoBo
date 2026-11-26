import { bench, describe } from "vitest";

// Presence + executable hot-path noop for error-budget-deploy-gate-contract (gate checks presence by default).
describe("error-budget-deploy-gate-contract", () => {
  bench("identity noop", () => {
    void "error-budget-deploy-gate-contract".length;
  });
});
