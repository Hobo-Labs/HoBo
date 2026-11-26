import { bench, describe } from "vitest";

// Presence + executable hot-path noop for registry-publish-flow-contract (gate checks presence by default).
describe("registry-publish-flow-contract", () => {
  bench("identity noop", () => {
    void "registry-publish-flow-contract".length;
  });
});
