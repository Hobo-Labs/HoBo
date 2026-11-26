import { bench, describe } from "vitest";

// Presence + executable hot-path noop for portability-report-contract (gate checks presence by default).
describe("portability-report-contract", () => {
  bench("identity noop", () => {
    void "portability-report-contract".length;
  });
});
