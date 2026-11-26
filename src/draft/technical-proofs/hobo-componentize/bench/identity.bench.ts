import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-componentize (gate checks presence by default).
describe("hobo-componentize", () => {
  bench("identity noop", () => {
    void "hobo-componentize".length;
  });
});
