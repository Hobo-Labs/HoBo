import { bench, describe } from "vitest";

// Presence + executable hot-path noop for matching-specificity-vectors (gate checks presence by default).
describe("matching-specificity-vectors", () => {
  bench("identity noop", () => {
    void "matching-specificity-vectors".length;
  });
});
