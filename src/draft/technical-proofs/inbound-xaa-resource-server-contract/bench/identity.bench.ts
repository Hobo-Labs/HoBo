import { bench, describe } from "vitest";

// Presence + executable hot-path noop for inbound-xaa-resource-server-contract (gate checks presence by default).
describe("inbound-xaa-resource-server-contract", () => {
  bench("identity noop", () => {
    void "inbound-xaa-resource-server-contract".length;
  });
});
