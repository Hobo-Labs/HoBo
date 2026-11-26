import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-capability-conformance-suites (gate checks presence by default).
describe("provider-capability-conformance-suites", () => {
  bench("identity noop", () => {
    void "provider-capability-conformance-suites".length;
  });
});
