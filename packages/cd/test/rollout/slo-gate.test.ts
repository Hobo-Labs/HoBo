import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	HealthSourceKind,
	RolloutStrategy,
	VerificationSpecRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createRolloutOrchestrator } from "../../src/rollout/orchestrator.js";
import { createVerificationEngine } from "../../src/verification/engine.js";
import {
	json,
	query,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
} from "../verification/fakes.js";
import { MINUTE, promotion, TENANT } from "./fakes.js";
import { rig } from "./rig.js";

function sloRig() {
	const r = rig();
	let mode: "missing" | "healthy" | "breach" = "missing";
	const source = new ScriptedHealthSource(
		HealthSourceKind.PROMETHEUS,
		(call) => {
			const points =
				mode === "missing"
					? []
					: [call.toMs - MINUTE, call.toMs].map((observedAtMs) => ({
							value: call.query.startsWith("timestamp(")
								? observedAtMs / 1000
								: call.query === "burn"
									? mode === "breach"
										? 12
										: 0.1
									: 0.5,
							observedAtMs,
							seriesKey: "0",
							correlationKey: "0",
						}));
			return {
				ok: true,
				value: {
					points,
					values: points.map((item) => item.value),
					fromMs: call.fromMs,
					toMs: call.toMs,
				},
			};
		},
	);
	const verification = createVerificationEngine({
		store: r.store,
		tenant: TENANT,
		now: r.time.now,
		sources: [source],
		suites: new RecordingVerifyPort(),
		http: new ScriptedTransport(() => json(200, {})).transport,
	});
	const orchestrator = createRolloutOrchestrator({
		store: r.store,
		tenant: TENANT,
		now: r.time.now,
		engine: r.engine,
		traffic: r.traffic,
		verification,
		windows: r.windows,
		desired: r.desired,
		approvals: r.approvals,
		telemetry: r.telemetry,
	});
	const spec = create(VerificationSpecRecordSchema, {
		sloGate: {
			burnRate: query("burn", {
				query: "burn",
				unit: "burn_rate",
			}),
			remainingBudgetRatio: query("budget", {
				query: "budget",
				unit: "ratio",
			}),
		},
	});
	async function start(strategy: RolloutStrategy) {
		r.desired.promoted("prod-a", "freight-1");
		const planned = await orchestrator.plan(
			{
				promotion: promotion({ targets: ["prod-a"], strategy }),
				obligations: [],
				verification: spec,
				stagePercents: [],
				windows: [],
			},
			r.ctx,
		);
		if (!planned.ok) throw new Error("plan refused");
		return orchestrator.run(planned.value, r.ctx);
	}
	return {
		...r,
		orchestrator,
		verification,
		start,
		setMode: (value: typeof mode) => {
			mode = value;
		},
	};
}

describe("SLO gated rollouts", () => {
	it.each([
		RolloutStrategy.CANARY,
		RolloutStrategy.BLUE_GREEN,
	])("holds missing evidence, then resumes and promotes strategy %s", async (strategy) => {
		const r = sloRig();
		const started = await r.start(strategy);
		r.time.advance(31 * MINUTE);
		await r.verification.tick(r.ctx);
		await r.orchestrator.tick(r.ctx);
		const held = await r.orchestrator.get(started.rolloutId);
		expect(held?.status).toBe("running");
		expect(held?.reasons[0]?.code).toBe("rollout-slo-evidence-pending");
		expect(r.traffic.percents("prod-a")).toEqual(
			strategy === RolloutStrategy.CANARY ? [5] : [],
		);
		r.setMode("healthy");
		for (let i = 0; i < 6; i += 1) {
			r.time.advance(15 * MINUTE);
			await r.verification.tick(r.ctx);
			await r.orchestrator.tick(r.ctx);
			if ((await r.orchestrator.get(started.rolloutId))?.status === "promoted")
				break;
		}
		expect((await r.orchestrator.get(started.rolloutId))?.status).toBe(
			"promoted",
		);
		expect(r.traffic.percents("prod-a").at(-1)).toBe(100);
	});

	it("rolls back a canary after a sustained SLO breach", async () => {
		const r = sloRig();
		r.setMode("breach");
		const started = await r.start(RolloutStrategy.CANARY);
		r.time.advance(15 * MINUTE);
		await r.verification.tick(r.ctx);
		await r.orchestrator.tick(r.ctx);
		expect((await r.orchestrator.get(started.rolloutId))?.status).toBe(
			"rolled-back",
		);
		expect(r.traffic.percents("prod-a")).toEqual([5, 0]);
	});
});
