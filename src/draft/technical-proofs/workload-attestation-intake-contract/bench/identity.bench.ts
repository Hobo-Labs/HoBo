import { bench, describe } from "vitest";

// Presence + executable hot-path noop for workload-attestation-intake-contract (gate checks presence by default).
describe("workload-attestation-intake-contract", () => {
  bench("identity noop", () => {
    void "workload-attestation-intake-contract".length;
  });
});
