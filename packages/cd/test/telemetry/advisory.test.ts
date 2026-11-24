import { describe, expect, it } from "vitest";
import { emit as emitArtifact } from "../../src/artifacts/telemetry.js";
import { emit as emitFanout } from "../../src/fanout/journal.js";
import { emitCounter as emitFreight } from "../../src/freight/journal.js";
import { emit as emitInventory } from "../../src/inventory/support.js";
import type { TelemetrySink } from "../../src/ports.js";
import { emit as emitPosture } from "../../src/posture/journal.js";
import { emitMetric as emitPromotion } from "../../src/promotion/journal.js";
import { emitMetrics } from "../../src/telemetry/advisory.js";
import { emitCounter as emitWindows } from "../../src/windows/journal.js";

describe("advisory CD metrics", () => {
	it.each([
		"throw",
		"reject",
	] as const)("does not turn a %s exporter into a command failure", async (mode) => {
		const marker = "synthetic-private-exporter.invalid";
		const sink: TelemetrySink = {
			spans: async () => undefined,
			metrics:
				mode === "throw"
					? () => {
							throw new Error(marker);
						}
					: async () => {
							throw new Error(marker);
						},
		};
		const point = {
			name: "fixture",
			kind: "counter" as const,
			value: 1,
			unit: "1",
			atMs: 1,
			attributes: {},
		};
		for (const send of [
			() => emitMetrics(sink, [point]),
			() => emitArtifact(sink, point.name, point.atMs, point.attributes),
			() => emitFanout(sink, [point]),
			() => emitFreight(sink, point),
			() => emitInventory(sink, [point]),
			() => emitPosture(sink, [point]),
			() => emitPromotion(sink, point),
			() => emitWindows(sink, point),
		]) {
			await expect(send()).resolves.toBeUndefined();
		}
	});
});
