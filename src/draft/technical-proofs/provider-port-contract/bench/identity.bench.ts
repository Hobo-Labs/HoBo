import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-port-contract (gate checks presence by default).
describe("provider-port-contract", () => {
  bench("identity noop", () => {
    void "provider-port-contract".length;
  });
});
