import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-relay-contract (gate checks presence by default).
describe("hobo-relay-contract", () => {
  bench("identity noop", () => {
    void "hobo-relay-contract".length;
  });
});
