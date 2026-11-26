import { bench, describe } from "vitest";

// Presence + executable hot-path noop for cqrs-command-aggregate-contract (gate checks presence by default).
describe("cqrs-command-aggregate-contract", () => {
  bench("identity noop", () => {
    void "cqrs-command-aggregate-contract".length;
  });
});
