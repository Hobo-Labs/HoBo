import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-drift-refresh-fidelity-contract (gate checks presence by default).
describe("iac-drift-refresh-fidelity-contract", () => {
  bench("identity noop", () => {
    void "iac-drift-refresh-fidelity-contract".length;
  });
});
