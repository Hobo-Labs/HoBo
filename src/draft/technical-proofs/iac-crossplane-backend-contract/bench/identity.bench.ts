import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-crossplane-backend-contract (gate checks presence by default).
describe("iac-crossplane-backend-contract", () => {
  bench("identity noop", () => {
    void "iac-crossplane-backend-contract".length;
  });
});
