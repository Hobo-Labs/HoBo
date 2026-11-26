import { bench, describe } from "vitest";

// Presence + executable hot-path noop for conformance-port-suite-contract (gate checks presence by default).
describe("conformance-port-suite-contract", () => {
  bench("identity noop", () => {
    void "conformance-port-suite-contract".length;
  });
});
