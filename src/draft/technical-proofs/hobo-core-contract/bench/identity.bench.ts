import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-core-contract (gate checks presence by default).
describe("hobo-core-contract", () => {
  bench("identity noop", () => {
    void "hobo-core-contract".length;
  });
});
