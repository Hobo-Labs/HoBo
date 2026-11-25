import { bench, describe } from "vitest";

// Presence + executable hot-path noop for document-projection-sink-contract (gate checks presence by default).
describe("document-projection-sink-contract", () => {
  bench("identity noop", () => {
    void "document-projection-sink-contract".length;
  });
});
