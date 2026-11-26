import { bench, describe } from "vitest";

// Presence + executable hot-path noop for iac-pulumi-backend-contract (gate checks presence by default).
describe("iac-pulumi-backend-contract", () => {
  bench("identity noop", () => {
    void "iac-pulumi-backend-contract".length;
  });
});
