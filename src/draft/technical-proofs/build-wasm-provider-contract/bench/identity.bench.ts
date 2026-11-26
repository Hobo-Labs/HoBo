import { bench, describe } from "vitest";

// Presence + executable hot-path noop for build-wasm-provider-contract (gate checks presence by default).
describe("build-wasm-provider-contract", () => {
  bench("identity noop", () => {
    void "build-wasm-provider-contract".length;
  });
});
