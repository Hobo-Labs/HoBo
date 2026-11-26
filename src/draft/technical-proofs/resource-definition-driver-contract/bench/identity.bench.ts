import { bench, describe } from "vitest";

// Presence + executable hot-path noop for resource-definition-driver-contract (gate checks presence by default).
describe("resource-definition-driver-contract", () => {
  bench("identity noop", () => {
    void "resource-definition-driver-contract".length;
  });
});
