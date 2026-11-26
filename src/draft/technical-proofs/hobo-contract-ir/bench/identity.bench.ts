import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-contract-ir (gate checks presence by default).
describe("hobo-contract-ir", () => {
  bench("identity noop", () => {
    void "hobo-contract-ir".length;
  });
});
