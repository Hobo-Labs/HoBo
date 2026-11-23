import { describe, expect, it } from "vitest";
import { inspectStagedChecks } from "../steps/implementations.ts";

describe("staged agent checks", () => {
  it("selects the shared source and mirror checks for a skill edit", () => {
    const result = inspectStagedChecks("skill");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("source:guard");
    expect(result.stdout).toContain("skills:mirror-check");
    expect(result.stdout).not.toContain("turbo run test");
  });

  it("rejects an invalid base before selecting gates", () => {
    const result = inspectStagedChecks("skill", "missing-base");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--base=missing-base is not a commit");
    expect(result.stdout).not.toContain("Changed files:");
  });
});
