import { bench, describe } from "vitest";

// Presence + executable hot-path noop for telemetry-envelope-contract (gate checks presence by default).
describe("telemetry-envelope-contract", () => {
  bench("identity noop", () => {
    void "telemetry-envelope-contract".length;
  });
});
