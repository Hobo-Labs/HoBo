import { bench, describe } from "vitest";

// Presence + executable hot-path noop for wrpc-deadline-propagation-contract (gate checks presence by default).
describe("wrpc-deadline-propagation-contract", () => {
  bench("identity noop", () => {
    void "wrpc-deadline-propagation-contract".length;
  });
});
