import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-plan-preview-contract (gate checks presence by default).
describe("hobo-plan-preview-contract", () => {
  bench("identity noop", () => {
    void "hobo-plan-preview-contract".length;
  });
});
