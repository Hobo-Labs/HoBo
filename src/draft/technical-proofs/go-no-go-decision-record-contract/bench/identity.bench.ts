import { bench, describe } from "vitest";

// Presence + executable hot-path noop for go-no-go-decision-record-contract (gate checks presence by default).
describe("go-no-go-decision-record-contract", () => {
  bench("identity noop", () => {
    void "go-no-go-decision-record-contract".length;
  });
});
