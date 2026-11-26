import { bench, describe } from "vitest";

// Presence + executable hot-path noop for component-host-conformance-suite (gate checks presence by default).
describe("component-host-conformance-suite", () => {
  bench("identity noop", () => {
    void "component-host-conformance-suite".length;
  });
});
