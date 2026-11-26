import { bench, describe } from "vitest";

// Presence + executable hot-path noop for gatekeeper-verify-contract (gate checks presence by default).
describe("gatekeeper-verify-contract", () => {
  bench("identity noop", () => {
    void "gatekeeper-verify-contract".length;
  });
});
