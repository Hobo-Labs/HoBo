import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-principal-ref-contract (gate checks presence by default).
describe("hobo-principal-ref-contract", () => {
  bench("identity noop", () => {
    void "hobo-principal-ref-contract".length;
  });
});
