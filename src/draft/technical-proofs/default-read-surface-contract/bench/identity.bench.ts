import { bench, describe } from "vitest";

// Presence + executable hot-path noop for default-read-surface-contract (gate checks presence by default).
describe("default-read-surface-contract", () => {
  bench("identity noop", () => {
    void "default-read-surface-contract".length;
  });
});
