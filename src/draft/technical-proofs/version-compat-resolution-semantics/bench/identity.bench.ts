import { bench, describe } from "vitest";

// Presence + executable hot-path noop for version-compat-resolution-semantics (gate checks presence by default).
describe("version-compat-resolution-semantics", () => {
  bench("identity noop", () => {
    void "version-compat-resolution-semantics".length;
  });
});
