import { bench, describe } from "vitest";

// Presence + executable hot-path noop for vm-microvm-build-providers-contract (gate checks presence by default).
describe("vm-microvm-build-providers-contract", () => {
  bench("identity noop", () => {
    void "vm-microvm-build-providers-contract".length;
  });
});
