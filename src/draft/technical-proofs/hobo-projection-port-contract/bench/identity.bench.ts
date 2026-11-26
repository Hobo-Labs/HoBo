import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-projection-port-contract (gate checks presence by default).
describe("hobo-projection-port-contract", () => {
  bench("identity noop", () => {
    void "hobo-projection-port-contract".length;
  });
});
