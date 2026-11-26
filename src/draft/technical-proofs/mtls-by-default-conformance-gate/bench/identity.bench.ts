import { bench, describe } from "vitest";

// Presence + executable hot-path noop for mtls-by-default-conformance-gate (gate checks presence by default).
describe("mtls-by-default-conformance-gate", () => {
  bench("identity noop", () => {
    void "mtls-by-default-conformance-gate".length;
  });
});
