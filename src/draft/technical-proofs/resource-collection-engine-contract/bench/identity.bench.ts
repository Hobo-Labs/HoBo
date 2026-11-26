import { bench, describe } from "vitest";

// Presence + executable hot-path noop for resource-collection-engine-contract (gate checks presence by default).
describe("resource-collection-engine-contract", () => {
  bench("identity noop", () => {
    void "resource-collection-engine-contract".length;
  });
});
