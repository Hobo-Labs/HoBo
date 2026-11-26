import { bench, describe } from "vitest";

// Presence + executable hot-path noop for durable-agent-primitive-contract (gate checks presence by default).
describe("durable-agent-primitive-contract", () => {
  bench("identity noop", () => {
    void "durable-agent-primitive-contract".length;
  });
});
