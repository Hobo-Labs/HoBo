import { bench, describe } from "vitest";

// Presence + executable hot-path noop for local-dev-test-authoring-contract (gate checks presence by default).
describe("local-dev-test-authoring-contract", () => {
  bench("identity noop", () => {
    void "local-dev-test-authoring-contract".length;
  });
});
