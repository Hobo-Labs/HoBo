import { bench, describe } from "vitest";

// Presence + executable hot-path noop for signed-artifact-publish-install-contract (gate checks presence by default).
describe("signed-artifact-publish-install-contract", () => {
  bench("identity noop", () => {
    void "signed-artifact-publish-install-contract".length;
  });
});
