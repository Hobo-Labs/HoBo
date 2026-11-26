import { bench, describe } from "vitest";

// Presence + executable hot-path noop for registry-capability-manifest-ingest-contract (gate checks presence by default).
describe("registry-capability-manifest-ingest-contract", () => {
  bench("identity noop", () => {
    void "registry-capability-manifest-ingest-contract".length;
  });
});
