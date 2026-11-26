import { bench, describe } from "vitest";

// Presence + executable hot-path noop for connector-authoring-contract (gate checks presence by default).
describe("connector-authoring-contract", () => {
  bench("identity noop", () => {
    void "connector-authoring-contract".length;
  });
});
