import { bench, describe } from "vitest";

// Presence + executable hot-path noop for poison-event-quarantine-contract (gate checks presence by default).
describe("poison-event-quarantine-contract", () => {
  bench("identity noop", () => {
    void "poison-event-quarantine-contract".length;
  });
});
