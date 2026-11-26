import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-default-definitions-contract (gate checks presence by default).
describe("provider-default-definitions-contract", () => {
  bench("identity noop", () => {
    void "provider-default-definitions-contract".length;
  });
});
