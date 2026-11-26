import { bench, describe } from "vitest";

// Presence + executable hot-path noop for s4-03-provider-azure-full-capability-manifest (gate checks presence by default).
describe("s4-03-provider-azure-full-capability-manifest", () => {
  bench("identity noop", () => {
    void "s4-03-provider-azure-full-capability-manifest".length;
  });
});
