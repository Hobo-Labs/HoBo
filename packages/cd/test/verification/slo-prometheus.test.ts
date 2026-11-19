import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	VerificationSpecRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import {
	createVerificationEngine,
	replayVerificationFromStore,
} from "../../src/verification/index.js";
import { createPrometheusSource } from "../../src/verification/sources/prometheus.js";
import {
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
	ScriptedTransport,
	T0,
	TENANT,
} from "./fakes.js";

it("uses Prometheus source timestamps rather than range evaluation times", async () => {
	const http = new ScriptedTransport((request) => {
		const url = new URL(request.url);
		const expression = url.searchParams.get("query");
		const start = Number(url.searchParams.get("start"));
		const end = Number(url.searchParams.get("end"));
		const isTime = expression?.startsWith("timestamp(") === true;
		const isBurn = expression?.includes("slo_burn") === true;
		const metric = isTime
			? { service: "api" }
			: { service: "api", __name__: isBurn ? "slo_burn" : "slo_budget" };
		const values = [14, 15, 16]
			.map((minute) => {
				const evaluatedAt = (T0 + minute * MINUTE) / 1000;
				const sampleMinute = isBurn && minute === 15 ? 14 : minute;
				const value = isTime
					? (T0 + sampleMinute * MINUTE) / 1000
					: isBurn
						? 0.1
						: 0.5;
				return [evaluatedAt, String(value)] satisfies [number, string];
			})
			.filter(([at]) => at >= start && at <= end);
		return json(200, {
			status: "success",
			data: {
				resultType: "matrix",
				result: [
					{
						metric,
						values,
					},
				],
			},
		});
	});
	const store = new MemoryEventStore();
	const time = clock();
	const engine = createVerificationEngine({
		store,
		tenant: TENANT,
		now: time.now,
		sources: [
			createPrometheusSource({
				http: http.transport,
				credentials: new MapCredentials({}),
			}),
		],
		suites: new RecordingVerifyPort(),
		http: http.transport,
	});
	const spec = create(VerificationSpecRecordSchema, {
		sloGate: {
			burnRate: query("burn", {
				query: "slo_burn",
				unit: "burn_rate",
			}),
			remainingBudgetRatio: query("budget", {
				query: "slo_budget",
				unit: "ratio",
			}),
		},
	});
	const ctx = context(time.now);
	const id = await engine.start(
		{
			spec,
			freightId: fid("freight-1"),
			campId: camp("camp-a"),
			cohortAware: false,
		},
		ctx,
	);
	time.advance(15 * MINUTE);
	expect(await engine.tick(ctx)).toEqual([]);
	expect(
		http.requests.map((request) =>
			new URL(request.url).searchParams.get("query"),
		),
	).toEqual([
		"timestamp(slo_burn)",
		"slo_burn",
		"timestamp(slo_burn)",
		"timestamp(slo_budget)",
		"slo_budget",
		"timestamp(slo_budget)",
	]);
	time.advance(MINUTE);
	expect((await engine.tick(ctx))[0]?.verdict).toBe(VerificationVerdict.PASS);
	expect(await replayVerificationFromStore(store, id)).toMatchObject({
		matches: true,
	});
});
