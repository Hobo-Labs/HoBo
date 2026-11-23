import { describe, expect, it } from "vitest";
import { inspectStagedChecks } from "../steps/implementations.ts";

describe("narrow staged validation", () => {
  it("selects the changed package without selecting unrelated packages", () => {
    const result = inspectStagedChecks("package");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--filter=./packages/cli");
    expect(result.stdout).not.toContain("--filter=./packages/hobo");
  });

  it("reports an empty index without running checks", () => {
    const result = inspectStagedChecks("empty");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to validate for this scope");
  });
});
