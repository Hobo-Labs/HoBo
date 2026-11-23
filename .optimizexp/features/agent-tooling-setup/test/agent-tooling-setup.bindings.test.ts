import { describe, expect, it } from "vitest";
import { agentSetupHelp, agentSetupMissingName, gbrainWithoutProvider } from "../steps/implementations.ts";

describe("agent tooling setup", () => {
  it("shows the zero-key setup path without installing tools", () => {
    const result = agentSetupHelp();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--no-gbrain");
    expect(result.stdout).toContain("AUTH.md");
  });

  it("reports a missing agent name with usage", () => {
    const result = agentSetupMissingName();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing value for --agent");
    expect(result.stderr).toContain("Usage:");
  });

  it("does not start the optional server without an embedding provider", () => {
    const result = gbrainWithoutProvider();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no embedding provider configured");
    expect(result.stderr).toContain("gbrain init --pglite");
    expect(result.serverStarted).toBe(false);
  });
});
