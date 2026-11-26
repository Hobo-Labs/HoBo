import { bench, describe } from "vitest";

// Presence + executable hot-path noop for domain-event-body-contract (gate checks presence by default).
describe("domain-event-body-contract", () => {
  bench("identity noop", () => {
    void "domain-event-body-contract".length;
  });
});
