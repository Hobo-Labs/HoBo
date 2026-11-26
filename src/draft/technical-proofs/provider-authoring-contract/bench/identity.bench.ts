import { bench, describe } from "vitest";

// Presence + executable hot-path noop for provider-authoring-contract (gate checks presence by default).
describe("provider-authoring-contract", () => {
  bench("identity noop", () => {
    void "provider-authoring-contract".length;
  });
});
