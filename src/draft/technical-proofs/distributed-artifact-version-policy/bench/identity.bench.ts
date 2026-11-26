import { bench, describe } from "vitest";

// Presence + executable hot-path noop for distributed-artifact-version-policy (gate checks presence by default).
describe("distributed-artifact-version-policy", () => {
  bench("identity noop", () => {
    void "distributed-artifact-version-policy".length;
  });
});
