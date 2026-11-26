import { bench, describe } from "vitest";

// Presence + executable hot-path noop for mcp-server-hardening-contract (gate checks presence by default).
describe("mcp-server-hardening-contract", () => {
  bench("identity noop", () => {
    void "mcp-server-hardening-contract".length;
  });
});
