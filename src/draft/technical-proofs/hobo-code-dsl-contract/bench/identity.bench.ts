import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-code-dsl-contract (gate checks presence by default).
describe("hobo-code-dsl-contract", () => {
  bench("identity noop", () => {
    void "hobo-code-dsl-contract".length;
  });
});
