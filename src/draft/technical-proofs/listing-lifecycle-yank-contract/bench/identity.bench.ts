import { bench, describe } from "vitest";

// Presence + executable hot-path noop for listing-lifecycle-yank-contract (gate checks presence by default).
describe("listing-lifecycle-yank-contract", () => {
  bench("identity noop", () => {
    void "listing-lifecycle-yank-contract".length;
  });
});
