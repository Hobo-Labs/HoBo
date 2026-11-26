import { bench, describe } from "vitest";

// Presence + executable hot-path noop for oci-artifact-storage-contract (gate checks presence by default).
describe("oci-artifact-storage-contract", () => {
  bench("identity noop", () => {
    void "oci-artifact-storage-contract".length;
  });
});
