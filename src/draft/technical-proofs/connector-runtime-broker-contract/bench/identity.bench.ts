import { bench, describe } from "vitest";

// Presence + executable hot-path noop for connector-runtime-broker-contract (gate checks presence by default).
describe("connector-runtime-broker-contract", () => {
  bench("identity noop", () => {
    void "connector-runtime-broker-contract".length;
  });
});
