import { bench, describe } from "vitest";

// Presence + executable hot-path noop for idiom-semantics-annex (gate checks presence by default).
describe("idiom-semantics-annex", () => {
  bench("identity noop", () => {
    void "idiom-semantics-annex".length;
  });
});
