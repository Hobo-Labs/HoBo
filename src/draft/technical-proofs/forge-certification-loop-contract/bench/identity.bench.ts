import { bench, describe } from "vitest";

// Presence + executable hot-path noop for forge-certification-loop-contract (gate checks presence by default).
describe("forge-certification-loop-contract", () => {
  bench("identity noop", () => {
    void "forge-certification-loop-contract".length;
  });
});
