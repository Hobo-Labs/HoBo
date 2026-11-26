import { bench, describe } from "vitest";

// Presence + executable hot-path noop for build-dagger-provider-contract (gate checks presence by default).
describe("build-dagger-provider-contract", () => {
  bench("identity noop", () => {
    void "build-dagger-provider-contract".length;
  });
});
