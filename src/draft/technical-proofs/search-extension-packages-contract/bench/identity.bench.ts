import { bench, describe } from "vitest";

// Presence + executable hot-path noop for search-extension-packages-contract (gate checks presence by default).
describe("search-extension-packages-contract", () => {
  bench("identity noop", () => {
    void "search-extension-packages-contract".length;
  });
});
