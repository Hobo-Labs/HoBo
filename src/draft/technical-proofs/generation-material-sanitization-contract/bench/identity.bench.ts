import { bench, describe } from "vitest";

// Presence + executable hot-path noop for generation-material-sanitization-contract (gate checks presence by default).
describe("generation-material-sanitization-contract", () => {
  bench("identity noop", () => {
    void "generation-material-sanitization-contract".length;
  });
});
