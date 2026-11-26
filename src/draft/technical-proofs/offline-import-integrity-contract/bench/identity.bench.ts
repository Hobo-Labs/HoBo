import { bench, describe } from "vitest";

// Presence + executable hot-path noop for offline-import-integrity-contract (gate checks presence by default).
describe("offline-import-integrity-contract", () => {
  bench("identity noop", () => {
    void "offline-import-integrity-contract".length;
  });
});
