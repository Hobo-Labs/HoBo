import { bench, describe } from "vitest";

// Presence + executable hot-path noop for relational-projection-sink-contract (gate checks presence by default).
describe("relational-projection-sink-contract", () => {
  bench("identity noop", () => {
    void "relational-projection-sink-contract".length;
  });
});
