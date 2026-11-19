import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { afterAll, describe, expect, it } from "vitest";
import {
	SloBudgetObservationRecordSchema,
	SloBudgetProjectionRecordSchema,
} from "../src/_generated/slo_pb.js";
import { toCloudEvent } from "../src/envelope.js";
import { cloneAsJson } from "../src/json.js";
import { parseSloDefinition } from "../src/ports/slo.js";
import { computeSloStatus } from "../src/ports/slo-computation.js";
import {
	applySloBudgetEvent,
	initialSloBudgetProjection,
	makeSloBudgetEvent,
	makeSloDeclaredEvent,
	replaySloBudgetProjection,
	type SloEventContext,
} from "../src/ports/slo-events.js";
import { sloFixture } from "./slo-fixture.js";

const cue =
	process.env.HOBO_CUE_BIN ||
	fileURLToPath(
		new URL(
			`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);
const schema = fileURLToPath(
	new URL("../data-models/slo.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-slo-events-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const context = {
	id: "event-1",
	seq: 1,
	ts: "2026-06-26T04:00:00Z",
	actor: { kind: "service", id: "observer" },
	tenant: "checkout",
	meta: {
		traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
	},
} satisfies SloEventContext;
const definition = parseSloDefinition(sloFixture());
async function evaluated(good: number) {
	return computeSloStatus({
		definition,
		now: context.ts,
		sliSource: {
			readRatioSamples: () => [
				{ time: "2026-06-26T03:59:00Z", good, total: 1000 },
			],
		},
	});
}

describe("SLO events and projections", () => {
	it("uses the caller's event context and definition digest", () => {
		const event = makeSloDeclaredEvent(definition, context);
		const cloud = toCloudEvent(cloneAsJson(event));
		expect(cloud.source).toBe("hobo://checkout/slo:availability");
		expect(cloud.hoboactor).toEqual(context.actor);
		expect(cloud.hobometa).toEqual(context.meta);
		expect(event.data.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("emits measured exhaustion and recovery and replays their latest budget", async () => {
		const exhausted = makeSloBudgetEvent(
			await evaluated(985),
			"availability",
			context,
		);
		const recovered = makeSloBudgetEvent(
			await evaluated(1000),
			"availability",
			{ ...context, id: "event-2", seq: 2 },
		);
		if (!exhausted || !recovered)
			throw new Error("expected observable budget events");
		expect(exhausted.type).toBe("slo.BudgetExhausted");
		expect(recovered.type).toBe("slo.BudgetBurned");
		const initial = initialSloBudgetProjection(definition, "availability");
		const first = applySloBudgetEvent(initial, exhausted);
		const latest = applySloBudgetEvent(first, recovered);
		expect(first).toMatchObject({ exhausted: true, remainingBudgetRatio: 0 });
		expect(latest).toMatchObject({
			exhausted: false,
			remainingBudgetRatio: 1,
			consumedBudgetRatio: 0,
			lastSeq: 2,
		});
		expect(
			replaySloBudgetProjection(definition, "availability", [
				recovered,
				exhausted,
			]),
		).toEqual(latest);
		expect(applySloBudgetEvent(latest, recovered)).toBe(latest);
		expect(() => applySloBudgetEvent(latest, exhausted)).toThrow(/sequence/u);
		expect(() =>
			applySloBudgetEvent(latest, {
				...recovered,
				data: { ...recovered.data, good: 990 },
			}),
		).toThrow(/conflicting/u);
		const wire = fromJsonString(
			SloBudgetObservationRecordSchema,
			JSON.stringify(exhausted.data),
		);
		expect(
			fromBinary(
				SloBudgetObservationRecordSchema,
				toBinary(SloBudgetObservationRecordSchema, wire),
			).remainingBudgetRatio,
		).toBe(0);
		const projection = fromJsonString(
			SloBudgetProjectionRecordSchema,
			JSON.stringify(latest),
		);
		expect(
			fromBinary(
				SloBudgetProjectionRecordSchema,
				toBinary(SloBudgetProjectionRecordSchema, projection),
			).lastSeq,
		).toBe(2);
		for (const [name, document] of [
			["SloBudgetObservationRecord", exhausted.data],
			["SloBudgetProjectionRecord", latest],
		] as const) {
			const path = join(directory, `${name}.json`);
			writeFileSync(path, JSON.stringify(document));
			const result = spawnSync(
				cue,
				["vet", "-c", "-d", `#${name}`, schema, path],
				{ encoding: "utf8" },
			);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		}
	});

	it("reports the objective budget when a fast burn window triggers", async () => {
		const value = sloFixture();
		const slo = parseSloDefinition({
			...value,
			spec: {
				...value.spec,
				timeWindow: { duration: "1h", isRolling: true },
				burnRateThresholds: [
					{
						name: "fast",
						threshold: 14.4,
						lookbackWindow: "5m",
						samplingInterval: "1m",
					},
				],
			},
		});
		const status = await computeSloStatus({
			definition: slo,
			now: context.ts,
			sliSource: {
				readRatioSamples: () => [
					{ time: "2026-06-26T03:50:00Z", good: 100000, total: 100000 },
					{ time: "2026-06-26T03:59:00Z", good: 80, total: 100 },
				],
			},
		});
		const event = makeSloBudgetEvent(status, "availability", context);
		expect(status.status).toBe("burning");
		expect(event?.data.window).toBe("fast");
		expect(event?.data.remainingBudgetRatio).toBe(
			status.objectives[0]?.window.remainingBudgetRatio,
		);
		expect(event?.data.remainingBudgetRatio).toBeGreaterThan(0.98);
	});

	it("rejects inconsistent observations and ungateable objectives do not emit budget events", async () => {
		const event = makeSloBudgetEvent(
			await evaluated(985),
			"availability",
			context,
		);
		if (!event) throw new Error("expected budget event");
		const initial = initialSloBudgetProjection(definition, "availability");
		expect(() =>
			applySloBudgetEvent(initial, {
				...event,
				data: { ...event.data, good: 1001 },
			}),
		).toThrow(/out of range/u);
		expect(() =>
			applySloBudgetEvent(initial, { ...event, streamId: "slo:other" }),
		).toThrow(/stream/u);
		const value = sloFixture();
		const perfect = parseSloDefinition({
			...value,
			spec: {
				...value.spec,
				objectives: [{ displayName: "perfect", target: 1 }],
			},
		});
		const evaluation = await computeSloStatus({
			definition: perfect,
			now: context.ts,
			sliSource: {
				readRatioSamples: () => [
					{ time: "2026-06-26T03:59:00Z", good: 1, total: 1 },
				],
			},
		});
		expect(initialSloBudgetProjection(perfect, "perfect")).toMatchObject({
			gateable: false,
			reason: "objective-has-no-error-budget",
		});
		expect(makeSloBudgetEvent(evaluation, "perfect", context)).toBeUndefined();
	});
});
