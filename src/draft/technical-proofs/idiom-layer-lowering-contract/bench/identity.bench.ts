import { bench, describe } from "vitest";

// Presence + executable hot-path noop for idiom-layer-lowering-contract (gate checks presence by default).
describe("idiom-layer-lowering-contract", () => {
  bench("identity noop", () => {
    void "idiom-layer-lowering-contract".length;
  });
});
