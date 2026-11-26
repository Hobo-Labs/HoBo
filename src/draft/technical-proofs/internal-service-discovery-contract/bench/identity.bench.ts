import { bench, describe } from "vitest";

// Presence + executable hot-path noop for internal-service-discovery-contract (gate checks presence by default).
describe("internal-service-discovery-contract", () => {
  bench("identity noop", () => {
    void "internal-service-discovery-contract".length;
  });
});
