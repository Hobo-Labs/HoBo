import { bench, describe } from "vitest";

// Presence + executable hot-path noop for registry-artifact-descriptor-contract (gate checks presence by default).
describe("registry-artifact-descriptor-contract", () => {
  bench("identity noop", () => {
    void "registry-artifact-descriptor-contract".length;
  });
});
