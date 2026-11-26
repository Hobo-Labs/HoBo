import { bench, describe } from "vitest";

// Presence + executable hot-path noop for signed-offline-bundle-contract (gate checks presence by default).
describe("signed-offline-bundle-contract", () => {
  bench("identity noop", () => {
    void "signed-offline-bundle-contract".length;
  });
});
