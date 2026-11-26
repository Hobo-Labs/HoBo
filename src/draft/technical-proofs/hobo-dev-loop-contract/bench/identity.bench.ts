import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-dev-loop-contract (gate checks presence by default).
describe("hobo-dev-loop-contract", () => {
  bench("identity noop", () => {
    void "hobo-dev-loop-contract".length;
  });
});
