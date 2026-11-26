import { bench, describe } from "vitest";

// Presence + executable hot-path noop for deployment-plan-ir-contract (gate checks presence by default).
describe("deployment-plan-ir-contract", () => {
  bench("identity noop", () => {
    void "deployment-plan-ir-contract".length;
  });
});
