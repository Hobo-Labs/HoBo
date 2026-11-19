import { describe, expect, it } from "vitest";
import {
	Cohort,
	HealthSourceKind,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createVerificationEngine } from "../../src/verification/index.js";
import { createPrometheusSource } from "../../src/verification/sources/prometheus.js";
import {
	bodyObject,
	camp,
	clock,
	context,
	fid,
	json,
	MapCredentials,
	MemoryEventStore,
	MINUTE,
	query,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
	T0,
	TENANT,
	thresholdSpec,
} from "./fakes.js";

function source() {
	const http = new ScriptedTransport(() =>
		json(200, {
			status: "success",
			data: {
				resultType: "matrix",
				result: [
					{ metric: { pod: "b" }, values: [[(T0 + 2_000) / 1000, "0.02"]] },
					{ metric: { pod: "a" }, values: [[(T0 + 1_000) / 1000, "0.01"]] },
				],
			},
		}),
	);
	return {
		source: createPrometheusSource({
			http: http.transport,
			credentials: new MapCredentials({}),
		}),
		http,
	};
}

describe("verification sample observation times", () => {
	it("preserves Prometheus point times and deterministic series identity", async () => {
		const { source: prometheus } = source();
		const result = await prometheus.query(
			{
				query: query("error_rate", { unit: "ratio" }),
				campId: camp("camp-a"),
				cohort: Cohort.ALL,
				fromMs: T0,
				toMs: T0 + 10 * MINUTE,
				signal: new AbortController().signal,
			},
			context(() => T0),
		);
		if (!result.ok) throw new Error("source query failed");
		expect(result.value.values).toEqual([0.01, 0.02]);
		expect(result.value.points).toMatchObject([
			{ value: 0.01, observedAtMs: T0 + 1_000 },
			{ value: 0.02, observedAtMs: T0 + 2_000 },
		]);
		const keys = result.value.points?.map((point) => point.seriesKey) ?? [];
		expect(keys).toHaveLength(2);
		expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
		expect(keys[1]).toMatch(/^[0-9a-f]{64}$/);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it("keeps a series identity when another series disappears", async () => {
		let multiple = true;
		const http = new ScriptedTransport(() =>
			json(200, {
				status: "success",
				data: {
					resultType: "matrix",
					result: [
						...(multiple
							? [{ metric: { pod: "a" }, values: [[T0 / 1000, "1"]] }]
							: []),
						{ metric: { pod: "b" }, values: [[T0 / 1000, "2"]] },
					],
				},
			}),
		);
		const prometheus = createPrometheusSource({
			http: http.transport,
			credentials: new MapCredentials({}),
		});
		const input = {
			query: query("error_rate"),
			campId: camp("camp-a"),
			cohort: Cohort.ALL,
			fromMs: T0,
			toMs: T0 + MINUTE,
			signal: new AbortController().signal,
		};
		const first = await prometheus.query(
			input,
			context(() => T0),
		);
		multiple = false;
		const second = await prometheus.query(
			input,
			context(() => T0),
		);
		if (!first.ok || !second.ok) throw new Error("source query failed");
		expect(second.value.points?.[0]?.seriesKey).toBe(
			first.value.points?.[1]?.seriesKey,
		);
		expect(second.value.points?.[0]?.seriesKey).not.toBe(
			first.value.points?.[0]?.seriesKey,
		);
	});

	it("records sample times in the verification journal", async () => {
		const { source: prometheus, http } = source();
		const store = new MemoryEventStore();
		const time = clock();
		const engine = createVerificationEngine({
			store,
			tenant: TENANT,
			now: time.now,
			sources: [prometheus],
			suites: new RecordingVerifyPort(),
			http: http.transport,
		});
		const ctx = context(time.now);
		const id = await engine.start(
			{
				spec: thresholdSpec({ requiredObservations: 2 }),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			ctx,
		);
		time.advance(10 * MINUTE);
		const [result] = await engine.tick(ctx);
		expect(result?.verdict).toBe(VerificationVerdict.PASS);
		const evidence = store
			.events(CD_STREAMS.verification(id))
			.filter((event) => event.type === CD_EVENTS.RolloutEvidenceObserved)
			.map((event) => bodyObject(event.data));
		expect(evidence).toMatchObject([
			{
				value: 0.01,
				observedAt: new Date(T0 + 1_000).toISOString(),
				seriesKey: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
			{
				value: 0.02,
				observedAt: new Date(T0 + 2_000).toISOString(),
				seriesKey: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		]);
		expect(prometheus.kind).toBe(HealthSourceKind.PROMETHEUS);
	});

	it("rejects a source response with misaligned sample metadata", async () => {
		const store = new MemoryEventStore();
		const time = clock();
		const source = new ScriptedHealthSource(
			HealthSourceKind.PROMETHEUS,
			() => ({
				ok: true,
				value: {
					values: [0.01, 0.02],
					fromMs: T0,
					toMs: T0 + 10 * MINUTE,
					points: [{ value: 0.01, observedAtMs: T0, seriesKey: "0" }],
				},
			}),
		);
		const engine = createVerificationEngine({
			store,
			tenant: TENANT,
			now: time.now,
			sources: [source],
			suites: new RecordingVerifyPort(),
			http: new ScriptedTransport(() => json(200, {})).transport,
		});
		const ctx = context(time.now);
		await engine.start(
			{
				spec: thresholdSpec({ requiredObservations: 2 }),
				freightId: fid("sha256:f1"),
				campId: camp("camp-a"),
				cohortAware: false,
			},
			ctx,
		);
		time.advance(10 * MINUTE);
		const [result] = await engine.tick(ctx);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.reasons.map((reason) => reason.code)).toContain(
			"health-source-response-invalid",
		);
	});
});
