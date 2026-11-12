// Health-source behaviour outside the happy-path contracts: refusals that
// must be typed and secret-free, order independence (I8), the step rule, and
// the HOBO_POSTURE source (D24) end to end through the engine.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Cohort, HealthQueryRecordSchema, HealthSourceKind, VerificationVerdict } from "../../../src/_generated/cd_pb.js";
import type { CdFactories, Digest, PostureSeriesReader } from "../../../src/ports.js";
import {
	createHealthSources,
	createHoboPostureSource,
	createPrometheusSource,
	createVerificationEngine,
	informVerificationSpec,
	parseVerificationSpec,
	prometheusStepSeconds,
	resolvePointer,
} from "../../../src/verification/index.js";
import {
	camp,
	clock,
	context,
	fid,
	json,
	MapCredentials,
	MemoryEventStore,
	MINUTE,
	RecordingVerifyPort,
	ScriptedTransport,
	T0,
	TENANT,
} from "../fakes.js";

const RAIL: Digest = `sha256:${"ab".repeat(32)}`;
const HOUR = 60 * MINUTE;

function promQuery(fields: MessageInitShape<typeof HealthQueryRecordSchema> = {}) {
	return create(HealthQueryRecordSchema, {
		name: "errors",
		source: HealthSourceKind.PROMETHEUS,
		endpointRef: "https://prometheus.example.com",
		query: "sum by (track) (errors)",
		cohortLabel: "track",
		...fields,
	});
}

const window = (fromMs = T0, toMs = T0 + 10 * MINUTE) => ({ campId: camp("camp-a"), fromMs, toMs, signal: new AbortController().signal });

describe("factories match the frozen CdFactories signatures", () => {
	it("createVerificationEngine and createHealthSources", () => {
		expectTypeOf(createVerificationEngine).toMatchTypeOf<CdFactories["createVerificationEngine"]>();
		expectTypeOf(createHealthSources).toMatchTypeOf<CdFactories["createHealthSources"]>();
	});

	it("createHealthSources covers every kind once; posture only when a reader is wired", () => {
		const deps = { http: new ScriptedTransport(() => json(200, {})).transport, credentials: new MapCredentials({}) };
		const kinds = createHealthSources(deps).map((source) => source.kind);
		expect(kinds).toEqual([
			HealthSourceKind.PROMETHEUS,
			HealthSourceKind.HOBO_METERING,
			HealthSourceKind.HTTP_JSON,
			HealthSourceKind.DATADOG,
			HealthSourceKind.NEW_RELIC,
			HealthSourceKind.CLOUDWATCH,
		]);
		const reader: PostureSeriesReader = { noncompliantRatio: async () => [], shadowDivergence: async () => [] };
		expect(createHealthSources({ ...deps, posture: reader }).map((source) => source.kind)).toContain(HealthSourceKind.HOBO_POSTURE);
	});
});

describe("typed, secret-free refusals", () => {
	const ctx = context(() => T0 + 10 * MINUTE);

	it("a split cohort without cohort_label is refused before any request", async () => {
		const http = new ScriptedTransport(() => json(200, {}));
		const source = createPrometheusSource({ http: http.transport, credentials: new MapCredentials({}) });
		const outcome = await source.query({ ...window(), query: promQuery({ cohortLabel: "" }), cohort: Cohort.CANARY }, ctx);
		expect(outcome.ok ? [] : outcome.reasons.map((r) => r.code)).toEqual(["health-source-cohort-label-missing"]);
		expect(http.requests).toHaveLength(0);
	});

	it("an unresolvable credential is refused without echoing the resolver's message", async () => {
		const http = new ScriptedTransport(() => json(200, {}));
		const source = createPrometheusSource({ http: http.transport, credentials: new MapCredentials({}) });
		const outcome = await source.query({ ...window(), query: promQuery({ credentialRef: "vault://secret/prom" }), cohort: Cohort.ALL }, ctx);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reasons[0]?.code).toBe("health-source-credential-unavailable");
		expect(JSON.stringify(outcome.reasons)).not.toContain("vault://");
	});

	it("credentials are scoped to the Camp's verification", async () => {
		const credentials = new MapCredentials({ prom: { authorization: "Bearer t" } });
		const http = new ScriptedTransport(() => json(200, { status: "success", data: { resultType: "matrix", result: [] } }));
		await createPrometheusSource({ http: http.transport, credentials }).query({ ...window(), query: promQuery({ credentialRef: "prom" }), cohort: Cohort.ALL }, ctx);
		expect(credentials.resolved).toEqual([{ ref: "prom", scope: "cd.verification:camp-a" }]);
		expect(http.requests[0]?.headers.authorization).toBe("Bearer t");
	});

	it("transport failure, non-JSON body and malformed matrix are distinct typed refusals", async () => {
		const answers = ["throw", { status: 200, headers: {}, body: "<html>" }, json(200, { status: "success", data: { resultType: "vector", result: [] } })] as const;
		const found: string[] = [];
		for (const answer of answers) {
			const http = new ScriptedTransport(() => answer);
			const outcome = await createPrometheusSource({ http: http.transport, credentials: new MapCredentials({}) }).query(
				{ ...window(), query: promQuery(), cohort: Cohort.ALL },
				ctx,
			);
			found.push(outcome.ok ? "ok" : (outcome.reasons[0]?.code ?? ""));
		}
		expect(found).toEqual(["health-source-transport-failed", "health-source-response-invalid", "health-source-response-invalid"]);
	});

	it("every request is bounded in time and size", async () => {
		const http = new ScriptedTransport(() => json(200, { status: "success", data: { resultType: "matrix", result: [] } }));
		await createPrometheusSource({ http: http.transport, credentials: new MapCredentials({}) }).query({ ...window(), query: promQuery(), cohort: Cohort.ALL }, ctx);
		expect(http.requests[0]?.timeoutMs).toBe(10_000);
		expect(http.requests[0]?.maxResponseBytes).toBe(4 * 1024 * 1024);
	});
});

describe("determinism (I8)", () => {
	it("samples do not depend on the order the source returns series in", async () => {
		const a = { metric: { track: "canary", pod: "a" }, values: [[1, "1"]] };
		const b = { metric: { track: "canary", pod: "b" }, values: [[1, "2"]] };
		const read = async (result: unknown[]) => {
			const http = new ScriptedTransport(() => json(200, { status: "success", data: { resultType: "matrix", result } }));
			const outcome = await createPrometheusSource({ http: http.transport, credentials: new MapCredentials({}) }).query(
				{ ...window(), query: promQuery(), cohort: Cohort.CANARY },
				context(() => T0),
			);
			return outcome.ok ? outcome.value.values : [];
		};
		expect(await read([a, b])).toEqual(await read([b, a]));
	});

	it("the Prometheus step is aligned to the window: ≥15 s and at most 60 points", () => {
		expect(prometheusStepSeconds(T0, T0 + 10 * MINUTE)).toBe(15);
		expect(prometheusStepSeconds(T0, T0 + 24 * HOUR)).toBe(1440);
	});

	it("+Inf survives decoding so the verdict can reject it as an invalid sample", async () => {
		const http = new ScriptedTransport(() => json(200, { status: "success", data: { resultType: "matrix", result: [{ metric: {}, values: [[1, "+Inf"]] }] } }));
		const outcome = await createPrometheusSource({ http: http.transport, credentials: new MapCredentials({}) }).query(
			{ ...window(), query: promQuery(), cohort: Cohort.ALL },
			context(() => T0),
		);
		expect(outcome.ok && outcome.value.values).toEqual([Number.POSITIVE_INFINITY]);
	});

	it("JSON pointers follow RFC 6901 escaping", () => {
		expect(resolvePointer({ "a/b": { "m~n": [1] } }, "/a~1b/m~0n/0")).toBe(1);
		expect(resolvePointer({ a: [1] }, "/a/01")).toBeUndefined();
	});
});

describe("HOBO_POSTURE source (D24)", () => {
	function reader(ratio: readonly number[], divergence: readonly number[]) {
		const calls: unknown[] = [];
		const posture: PostureSeriesReader = {
			async noncompliantRatio(input) {
				calls.push(["ratio", input]);
				return ratio;
			},
			async shadowDivergence(input) {
				calls.push(["divergence", input]);
				return divergence;
			},
		};
		return { posture, calls };
	}

	async function verifyInform(ratio: readonly number[], divergence: readonly number[]) {
		const { posture, calls } = reader(ratio, divergence);
		const store = new MemoryEventStore();
		const time = clock();
		const engine = createVerificationEngine({
			store,
			tenant: TENANT,
			now: time.now,
			sources: [createHoboPostureSource(posture)],
			suites: new RecordingVerifyPort(),
			http: new ScriptedTransport(() => json(200, {})).transport,
		});
		const ctx = context(time.now);
		await engine.start({ spec: informVerificationSpec({ railDigest: RAIL }), freightId: fid("sha256:rail"), campId: camp("camp-a"), cohortAware: false }, ctx);
		time.advance(24 * HOUR);
		const [result] = await engine.tick(ctx);
		return { result, calls };
	}

	it("the R12 default INFORM spec parses with the CD_DEFAULTS window", () => {
		const parsed = parseVerificationSpec(informVerificationSpec({ railDigest: RAIL }));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value.windowMs).toBe(BigInt(24 * HOUR));
	});

	it("a window without compliance records is no data, so FAIL", async () => {
		const { result } = await verifyInform([], [0]);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.checks.find((c) => c.check === "threshold:posture-noncompliant-ratio")?.reason?.code).toBe("verification-no-data");
	});

	it("≤ 2% noncompliant and zero divergences passes; reads the candidate Rail's series", async () => {
		const { result, calls } = await verifyInform([0, 0.01, 0.02], [0, 0]);
		expect(result?.verdict).toBe(VerificationVerdict.PASS);
		expect(calls).toEqual([
			["ratio", { campId: "camp-a", fromMs: T0, toMs: T0 + 24 * HOUR, railDigest: RAIL }],
			["divergence", { campId: "camp-a", fromMs: T0, toMs: T0 + 24 * HOUR, railDigest: RAIL }],
		]);
	});

	it("one shadow divergence fails", async () => {
		const { result } = await verifyInform([0], [0, 1]);
		expect(result?.verdict).toBe(VerificationVerdict.FAIL);
		expect(result?.checks.find((c) => c.check === "threshold:posture-shadow-divergence")?.reason?.code).toBe("verification-threshold-breached");
	});

	it("unknown series, missing digest and a baseline cohort are typed refusals", async () => {
		const { posture } = reader([], []);
		const source = createHoboPostureSource(posture);
		const ask = async (query: string, endpointRef: string, cohort: Cohort) => {
			const outcome = await source.query(
				{ ...window(), query: create(HealthQueryRecordSchema, { name: "p", source: HealthSourceKind.HOBO_POSTURE, query, endpointRef }), cohort },
				context(() => T0),
			);
			return outcome.ok ? "ok" : outcome.reasons[0]?.code;
		};
		expect(await ask("compliance_score", "", Cohort.ALL)).toBe("health-source-query-invalid");
		expect(await ask("shadow_divergence_count", "", Cohort.ALL)).toBe("health-source-query-invalid");
		expect(await ask("noncompliant_ratio", "not-a-digest", Cohort.ALL)).toBe("health-source-endpoint-invalid");
		expect(await ask("noncompliant_ratio", "", Cohort.BASELINE)).toBe("health-source-query-invalid");
		expect(await ask("noncompliant_ratio", "", Cohort.CANARY)).toBe("ok");
	});
});
