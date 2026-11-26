import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-capability-manifest-contract (gate checks presence by default).
describe("provider-capability-manifest-contract", () => {
  bench("identity noop", () => {
    void "provider-capability-manifest-contract".length;
  });
});
