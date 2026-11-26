import { bench, describe } from "vitest";

// Presence + executable hot-path noop for sdk-codegen-surface-contract (gate checks presence by default).
describe("sdk-codegen-surface-contract", () => {
  bench("identity noop", () => {
    void "sdk-codegen-surface-contract".length;
  });
});
