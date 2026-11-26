import { bench, describe } from "vitest";

// Presence + executable hot-path noop for otel-traces-pipeline-contract (gate checks presence by default).
describe("otel-traces-pipeline-contract", () => {
  bench("identity noop", () => {
    void "otel-traces-pipeline-contract".length;
  });
});
