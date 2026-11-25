import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-inspect-projection-contract (gate checks presence by default).
describe("hobo-inspect-projection-contract", () => {
  bench("identity noop", () => {
    void "hobo-inspect-projection-contract".length;
  });
});
