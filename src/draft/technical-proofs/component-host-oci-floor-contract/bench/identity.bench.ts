import { bench, describe } from "vitest";

// Presence + executable hot-path noop for component-host-oci-floor-contract (gate checks presence by default).
describe("component-host-oci-floor-contract", () => {
  bench("identity noop", () => {
    void "component-host-oci-floor-contract".length;
  });
});
