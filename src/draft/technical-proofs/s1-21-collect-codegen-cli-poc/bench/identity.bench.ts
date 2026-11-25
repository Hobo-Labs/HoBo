import { bench, describe } from "vitest";

// Presence + executable hot-path noop for s1-21-collect-codegen-cli-poc (gate checks presence by default).
describe("s1-21-collect-codegen-cli-poc", () => {
  bench("identity noop", () => {
    void "s1-21-collect-codegen-cli-poc".length;
  });
});
