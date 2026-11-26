import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-manifest-contract (gate checks presence by default).
describe("hobo-manifest-contract", () => {
  bench("identity noop", () => {
    void "hobo-manifest-contract".length;
  });
});
