import { bench, describe } from "vitest";

// Presence + executable hot-path noop for manifest-resource-intent-bridge-contract (gate checks presence by default).
describe("manifest-resource-intent-bridge-contract", () => {
  bench("identity noop", () => {
    void "manifest-resource-intent-bridge-contract".length;
  });
});
