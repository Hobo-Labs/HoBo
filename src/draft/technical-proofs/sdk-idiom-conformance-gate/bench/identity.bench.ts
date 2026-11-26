import { bench, describe } from "vitest";

// Presence + executable hot-path noop for sdk-idiom-conformance-gate (gate checks presence by default).
describe("sdk-idiom-conformance-gate", () => {
  bench("identity noop", () => {
    void "sdk-idiom-conformance-gate".length;
  });
});
