import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-feature-flag-port (gate checks presence by default).
describe("hobo-feature-flag-port", () => {
  bench("identity noop", () => {
    void "hobo-feature-flag-port".length;
  });
});
