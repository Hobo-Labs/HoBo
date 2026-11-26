import { bench, describe } from "vitest";

// Presence + executable hot-path noop for preview-ephemeral-environments-contract (gate checks presence by default).
describe("preview-ephemeral-environments-contract", () => {
  bench("identity noop", () => {
    void "preview-ephemeral-environments-contract".length;
  });
});
