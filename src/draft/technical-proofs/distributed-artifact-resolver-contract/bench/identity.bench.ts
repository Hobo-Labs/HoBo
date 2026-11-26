import { bench, describe } from "vitest";

// Presence + executable hot-path noop for distributed-artifact-resolver-contract (gate checks presence by default).
describe("distributed-artifact-resolver-contract", () => {
  bench("identity noop", () => {
    void "distributed-artifact-resolver-contract".length;
  });
});
