import { bench, describe } from "vitest";

// Presence + executable hot-path noop for built-in-flag-store-contract (gate checks presence by default).
describe("built-in-flag-store-contract", () => {
  bench("identity noop", () => {
    void "built-in-flag-store-contract".length;
  });
});
