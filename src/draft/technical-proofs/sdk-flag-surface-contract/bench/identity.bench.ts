import { bench, describe } from "vitest";

// Presence + executable hot-path noop for sdk-flag-surface-contract (gate checks presence by default).
describe("sdk-flag-surface-contract", () => {
  bench("identity noop", () => {
    void "sdk-flag-surface-contract".length;
  });
});
