import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-azure-contract (gate checks presence by default).
describe("provider-azure-contract", () => {
  bench("identity noop", () => {
    void "provider-azure-contract".length;
  });
});
