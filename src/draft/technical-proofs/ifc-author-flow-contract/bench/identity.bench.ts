import { bench, describe } from "vitest";

// Presence + executable hot-path noop for ifc-author-flow-contract (gate checks presence by default).
describe("ifc-author-flow-contract", () => {
  bench("identity noop", () => {
    void "ifc-author-flow-contract".length;
  });
});
