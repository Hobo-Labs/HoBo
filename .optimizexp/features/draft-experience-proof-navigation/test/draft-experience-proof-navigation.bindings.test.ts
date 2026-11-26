import { describe, expect, it } from "vitest";
import { runInventory } from "../steps/implementations.ts";

describe("experience proof navigation", () => {
  it("filters the real inventory by audience", () => {
    const result = runInventory("--type", "ax", "--json");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.proofs.length).toBeGreaterThan(0);
    expect(output.proofs.every((proof: { type: string }) => proof.type === "ax")).toBe(true);
  });

  it("rejects an unknown audience", () => {
    const result = runInventory("--type", "unknown");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("choose dx, ux, cx, ax, api");
  });
});
