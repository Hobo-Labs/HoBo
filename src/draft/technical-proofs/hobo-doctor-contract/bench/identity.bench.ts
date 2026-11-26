import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-doctor-contract (gate checks presence by default).
describe("hobo-doctor-contract", () => {
  bench("identity noop", () => {
    void "hobo-doctor-contract".length;
  });
});
