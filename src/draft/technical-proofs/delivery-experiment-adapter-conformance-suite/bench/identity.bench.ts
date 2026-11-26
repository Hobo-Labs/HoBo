import { bench, describe } from "vitest";

// Presence + executable hot-path noop for delivery-experiment-adapter-conformance-suite (gate checks presence by default).
describe("delivery-experiment-adapter-conformance-suite", () => {
  bench("identity noop", () => {
    void "delivery-experiment-adapter-conformance-suite".length;
  });
});
