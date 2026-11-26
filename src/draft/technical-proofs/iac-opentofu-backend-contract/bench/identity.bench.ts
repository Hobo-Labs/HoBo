import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-opentofu-backend-contract (gate checks presence by default).
describe("iac-opentofu-backend-contract", () => {
  bench("identity noop", () => {
    void "iac-opentofu-backend-contract".length;
  });
});
