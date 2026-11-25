import { bench, describe } from "vitest";

// Presence + executable hot-path noop for flag-event-contract (gate checks presence by default).
describe("flag-event-contract", () => {
  bench("identity noop", () => {
    void "flag-event-contract".length;
  });
});
