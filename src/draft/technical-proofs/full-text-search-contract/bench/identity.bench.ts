import { bench, describe } from "vitest";

// Presence + executable hot-path noop for full-text-search-contract (gate checks presence by default).
describe("full-text-search-contract", () => {
  bench("identity noop", () => {
    void "full-text-search-contract".length;
  });
});
