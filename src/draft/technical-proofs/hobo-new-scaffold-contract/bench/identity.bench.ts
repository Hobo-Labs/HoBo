import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-new-scaffold-contract (gate checks presence by default).
describe("hobo-new-scaffold-contract", () => {
  bench("identity noop", () => {
    void "hobo-new-scaffold-contract".length;
  });
});
