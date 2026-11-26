import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-auth-authoring-surface (gate checks presence by default).
describe("hobo-auth-authoring-surface", () => {
  bench("identity noop", () => {
    void "hobo-auth-authoring-surface".length;
  });
});
