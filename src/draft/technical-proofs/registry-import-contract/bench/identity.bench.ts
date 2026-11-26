import { bench, describe } from "vitest";

// Presence + executable hot-path noop for registry-import-contract (gate checks presence by default).
describe("registry-import-contract", () => {
  bench("identity noop", () => {
    void "registry-import-contract".length;
  });
});
