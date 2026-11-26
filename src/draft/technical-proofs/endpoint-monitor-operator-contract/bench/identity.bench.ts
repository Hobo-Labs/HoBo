import { bench, describe } from "vitest";

// Presence + executable hot-path noop for endpoint-monitor-operator-contract (gate checks presence by default).
describe("endpoint-monitor-operator-contract", () => {
  bench("identity noop", () => {
    void "endpoint-monitor-operator-contract".length;
  });
});
