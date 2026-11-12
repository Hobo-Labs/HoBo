// Shared wiring for the WP23 failover tests: a completed fan-out over two EU
// Camps, spares in the US and the EU, and a failover controller over fakes.
import { create } from "@bufbuild/protobuf";
import {
	FailoverPolicyRecordSchema,
	FanoutStrategy,
	PurgeMode,
	SignalSource,
	TaintEffect,
	type TaintRecord,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createFailoverController } from "../../src/failover/index.js";
import { decisionOf, fanoutOf, healthy, MINUTE } from "../fanout/fakes.js";
import { drive, harness, startInput } from "../fanout/harness.js";
import { FakePipelines, FakePlacement, FakeRails, FakeTraffic, topologyOf } from "./fakes.js";

export const EU_ONLY = { classifications: [], residency: [{ classifications: [], allowedJurisdictions: ["eu" as const] }] };

export function noRun(key: string, atMs: number): TaintRecord {
	return create(TaintRecordSchema, {
		key,
		effect: TaintEffect.NO_RUN,
		source: SignalSource.STATION,
		reason: "region outage",
		addedBy: "service:station-eu",
		addedAt: new Date(atMs).toISOString(),
	});
}

export async function setup(
	options: Readonly<{
		automatic?: boolean;
		maxConcurrent?: number;
		allowImmediatePurge?: boolean;
		purge?: PurgeMode;
		handoverOutputs?: string[];
		withContext?: boolean;
		ignoreResidency?: boolean;
	}> = {},
) {
	const h = harness();
	// Fleet: two serving Camps in the EU, spares in the US (sorted first) and the EU.
	const decision = decisionOf(2, 2, { prefix: "eu-" });
	h.inventory.add("eu-000", { regions: ["eu-west-1"], provider: "aws" });
	h.inventory.add("eu-001", { regions: ["eu-west-1"], provider: "aws" });
	h.inventory.add("a-us-spare", { regions: ["us-east-1"], provider: "azure" });
	h.inventory.add("eu-spare", { regions: ["eu-west-1"], provider: "azure" });
	h.inventory.add("eu-spare2", { regions: ["eu-west-1"], provider: "azure" });
	const started = await h.controller.start(startInput(decision, fanoutOf()), h.ctx);
	if (!started.ok) throw new Error("fan-out refused");
	await drive(h);
	const pipelines = new FakePipelines();
	pipelines.define("web", {
		fanout: fanoutOf({ strategy: FanoutStrategy.PROGRESSIVE, maxConcurrency: 1 }),
		failover: create(FailoverPolicyRecordSchema, {
			purge: options.purge ?? PurgeMode.UNSPECIFIED,
			handoverOutputs: options.handoverOutputs ?? [],
		}),
	});
	const placement = new FakePlacement(h.inventory);
	placement.ignoreResidency = options.ignoreResidency ?? false;
	const rails = new FakeRails({
		automatic: options.automatic ?? true,
		maxConcurrent: options.maxConcurrent ?? 1,
		allowImmediatePurge: options.allowImmediatePurge ?? false,
	});
	const traffic = new FakeTraffic();
	const failover = createFailoverController({
		store: h.store,
		tenant: h.ctx.tenant,
		now: h.time.now,
		pipelines,
		inventory: h.inventory,
		placement,
		fanout: h.controller,
		promotions: h.promotions,
		desired: h.desired,
		topology: topologyOf(h.inventory),
		rails,
		traffic,
		authorizer: h.authorizer,
		telemetry: h.telemetry,
		...(options.withContext === false ? {} : { placementContext: async () => ({ stationId: "station-eu", subject: EU_ONLY }) }),
	});
	return { h, failover, pipelines, placement, rails, traffic, fanoutId: started.value.fanoutId };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

export function taint(s: Setup, campId: string): void {
	s.h.inventory.setStatus(campId, healthy(campId, [noRun("region-down", s.h.time.now())], false));
}

/** Tick the failover controller, settling replacement promotions with `outcome`. */
export async function run(s: Setup, outcome: "pass" | "fail" | "hold" = "pass", ticks = 6): Promise<void> {
	for (let i = 0; i < ticks; i += 1) {
		await s.failover.tick(s.h.ctx);
		if (outcome !== "hold")
			for (const p of s.h.promotions.live("failover")) s.h.promotions.settle(p.targetCampIds[0] ?? "", outcome);
		s.h.time.advance(MINUTE);
	}
}

export const departs = (s: Setup, campId: string) =>
	s.h.promotions.calls.filter((c) => c.request.intent === "depart" && c.request.targets[0] === campId);

