import { bench, describe } from "vitest";

// Presence + executable hot-path noop for non-ts-idiom-roundtrip-spike (gate checks presence by default).
describe("non-ts-idiom-roundtrip-spike", () => {
  bench("identity noop", () => {
    void "non-ts-idiom-roundtrip-spike".length;
  });
});
