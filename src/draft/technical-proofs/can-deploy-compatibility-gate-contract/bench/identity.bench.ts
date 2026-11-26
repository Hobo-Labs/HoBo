import { bench, describe } from "vitest";

// Presence + executable hot-path noop for can-deploy-compatibility-gate-contract (gate checks presence by default).
describe("can-deploy-compatibility-gate-contract", () => {
  bench("identity noop", () => {
    void "can-deploy-compatibility-gate-contract".length;
  });
});
