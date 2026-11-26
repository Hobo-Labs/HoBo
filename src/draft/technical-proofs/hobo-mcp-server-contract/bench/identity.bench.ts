import { bench, describe } from "vitest";

// Presence + executable hot-path noop for hobo-mcp-server-contract (gate checks presence by default).
describe("hobo-mcp-server-contract", () => {
  bench("identity noop", () => {
    void "hobo-mcp-server-contract".length;
  });
});
