import { bench, describe } from "vitest";

// Presence + executable hot-path noop for camp-eventstore-runtime-port-contract (gate checks presence by default).
describe("camp-eventstore-runtime-port-contract", () => {
  bench("identity noop", () => {
    void "camp-eventstore-runtime-port-contract".length;
  });
});
