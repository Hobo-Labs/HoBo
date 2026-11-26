import { describe, expect, it } from "vitest";

import { parseJsonValue } from "../src/json.js";
import { deriveLayout, validateLayout } from "../src/layout.js";
import { createSimulation } from "../src/simulator.js";

// Regression: validateLayout used to cast untrusted JSON straight to domain
// records (`as Record<string, TilePoint>` etc.) behind invalid type
// predicates, which no longer compiled. It now parses every entry. These
// tests pin both directions: a well-formed layout round-trips, malformed
// payloads fail closed with reasons instead of throwing or passing.
describe("validateLayout", () => {
  it("accepts the derived layout after a JSON round-trip", () => {
    const sim = createSimulation(1);
    const stationId = Object.keys(sim.state.stations)[0];
    expect(stationId).toBeDefined();
    if (stationId === undefined) return;
    const derived = deriveLayout(sim.state, stationId);
    const raw = parseJsonValue(JSON.stringify(derived));
    const { layout, reasons } = validateLayout(raw, sim.state, stationId);
    expect(reasons).toEqual([]);
    expect(layout).toEqual(derived);
  });

  it("fails closed with reasons on malformed entries", () => {
    const sim = createSimulation(1);
    const stationId = Object.keys(sim.state.stations)[0];
    expect(stationId).toBeDefined();
    if (stationId === undefined) return;
    const raw = parseJsonValue(
      JSON.stringify({
        version: 1,
        grid: { w: 40, h: 30 },
        rooms: { bogus: { rect: { x: "no", y: 0, w: 4, h: 4 }, color: 7 } },
        desks: { ghost: { x: 1.5, y: 2 } },
        corridors: { nowhere: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
      }),
    );
    const { layout, reasons } = validateLayout(raw, sim.state, stationId);
    expect(layout).toBeUndefined();
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join("\n")).toContain("unknown camp");
  });

  it("rejects non-object payloads without throwing", () => {
    const sim = createSimulation(1);
    const stationId = Object.keys(sim.state.stations)[0];
    expect(stationId).toBeDefined();
    if (stationId === undefined) return;
    for (const raw of [null, "x", 42, [1, 2]] as const) {
      const { layout, reasons } = validateLayout(raw, sim.state, stationId);
      expect(layout).toBeUndefined();
      expect(reasons.length).toBeGreaterThan(0);
    }
  });
});
