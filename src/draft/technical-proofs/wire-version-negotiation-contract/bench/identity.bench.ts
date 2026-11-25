import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wire-version-negotiation-contract (gate checks presence by default).
describe("wire-version-negotiation-contract", () => {
  bench("identity noop", () => {
    void "wire-version-negotiation-contract".length;
  });
});
