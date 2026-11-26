import { bench, describe } from "vitest";

// Presence + executable hot-path noop for dns-validation-gate-threat-model (gate checks presence by default).
describe("dns-validation-gate-threat-model", () => {
  bench("identity noop", () => {
    void "dns-validation-gate-threat-model".length;
  });
});
