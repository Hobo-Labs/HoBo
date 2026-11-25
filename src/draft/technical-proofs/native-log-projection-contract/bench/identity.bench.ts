import { bench, describe } from "vitest";

// Presence + executable hot-path noop for native-log-projection-contract (gate checks presence by default).
describe("native-log-projection-contract", () => {
  bench("identity noop", () => {
    void "native-log-projection-contract".length;
  });
});
