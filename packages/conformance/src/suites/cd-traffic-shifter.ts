// TrafficShifter conformance (plan 0024 D7/D8, I5, I6). The one path a
// rollout uses to move exposure; it reports what was realized, honestly.
import type { ApplyResult, RoutingPlan, RoutingPlanId } from "@hobo/core";
import {
	abortedSignal,
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	requireCapability,
	runCdAssertions,
} from "./cd-kit.js";
import type { TrafficShifterLike } from "./cd-shapes.js";

export const TRAFFIC_SHIFTER_SUITE = "hobo.cd.traffic-shifter/v1";

// public-contract: assertion names of the TrafficShifter suite.
export const TRAFFIC_SHIFTER_ASSERTIONS = Object.freeze([
	"offeringsAreStable",
	"shiftEchoesPlan",
	"shiftIsObservable",
	"shiftIsIdempotent",
	"unknownPlanHasNoStatus",
	"noCapabilityIsHonest",
	"abortIsHonoured",
] as const);
export type TrafficShifterAssertion =
	(typeof TRAFFIC_SHIFTER_ASSERTIONS)[number];

export interface TrafficShifterHarness<TCtx> {
	readonly subject: string;
	readonly campId: string;
	create(): Promise<TrafficShifterLike<TCtx>>;
	/** A shifter for a Camp whose provider realizes no traffic offering. */
	createWithoutTraffic?(): Promise<TrafficShifterLike<TCtx>>;
	/** A plan sending `percent` to the candidate backend. */
	plan(percent: number): RoutingPlan;
	ctx(): TCtx;
}

const REALIZATIONS = new Set(["full", "partial", "none"]);

export async function runTrafficShifterConformance<TCtx>(
	harness: TrafficShifterHarness<TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<TrafficShifterAssertion>> {
	const live = () => new AbortController().signal;
	const shift = (
		shifter: TrafficShifterLike<TCtx>,
		plan: RoutingPlan,
		signal = live(),
	): Promise<ApplyResult> =>
		shifter.shift({ campId: harness.campId, plan, signal }, harness.ctx());
	return runCdAssertions<TrafficShifterAssertion>(
		TRAFFIC_SHIFTER_SUITE,
		harness.subject,
		{
			offeringsAreStable: async () => {
				const shifter = await harness.create();
				const first = await shifter.offerings(harness.campId);
				const second = await shifter.offerings(harness.campId);
				check(
					new Set(first).size === first.length,
					"offerings repeat an id",
					"declare each offering once",
				);
				check(
					first.join(",") === second.join(","),
					"offerings changed between calls",
					"offerings are declared, not sampled",
				);
				check(
					first.length > 0,
					"a traffic-capable Camp declared no offering",
					"declare the offerings the provider realizes (ADR-0143)",
				);
			},
			shiftEchoesPlan: async () => {
				const shifter = await harness.create();
				const plan = harness.plan(25);
				const result = await shift(shifter, plan);
				check(
					result.planId === plan.planId,
					`apply result names plan ${result.planId}`,
					"echo the applied planId",
				);
				check(
					REALIZATIONS.has(result.realized),
					`realized is ${result.realized}`,
					"report full, partial or none",
				);
			},
			shiftIsObservable: async () => {
				const shifter = await harness.create();
				const plan = harness.plan(25);
				const result = await shift(shifter, plan);
				const status = await shifter.status(harness.campId, plan.planId);
				check(
					status !== null,
					"status of an applied plan is null",
					"status reads back what the provider holds",
				);
				if (status === null) return;
				check(
					status.planId === plan.planId,
					"status names another plan",
					"status is keyed by planId",
				);
				check(
					status.realized === result.realized,
					`status realized ${status.realized} but apply reported ${result.realized}`,
					"apply and status must agree on what the provider realized",
				);
			},
			shiftIsIdempotent: async () => {
				const shifter = await harness.create();
				const plan = harness.plan(50);
				const first = await shift(shifter, plan);
				const second = await shift(shifter, plan);
				check(
					first.realized === second.realized,
					"re-applying a plan changed its realization",
					"applying a plan twice is a no-op (I12)",
				);
			},
			unknownPlanHasNoStatus: async () => {
				const shifter = await harness.create();
				// SAFETY: a branded id the shifter never saw; the brand only marks provenance.
				const unknown = "plan-never-applied" as RoutingPlanId;
				const status = await shifter.status(harness.campId, unknown);
				check(
					status === null,
					"a never-applied plan has a status",
					"status of an unknown plan is null",
				);
			},
			noCapabilityIsHonest: async () => {
				const create = requireCapability(
					harness.createWithoutTraffic,
					"createWithoutTraffic",
				);
				const shifter = await create();
				const offerings = await shifter.offerings(harness.campId);
				check(
					offerings.length === 0,
					"a provider without traffic declared offerings",
					"declare only realizable offerings (I6)",
				);
				let result: ApplyResult | undefined;
				try {
					result = await shift(shifter, harness.plan(5));
				} catch {
					result = undefined;
				}
				check(
					result === undefined || result.realized === "none",
					`a provider without traffic realized ${result?.realized}`,
					"refuse or report realized none; never claim exposure that did not change (C5)",
				);
			},
			abortIsHonoured: async () => {
				const shifter = await harness.create();
				const plan = harness.plan(5);
				let result: ApplyResult | undefined;
				try {
					result = await shift(shifter, plan, abortedSignal());
				} catch {
					result = undefined;
				}
				check(
					result === undefined || result.realized === "none",
					"an aborted shift realized traffic",
					"check the signal before applying",
				);
				const status = await shifter.status(harness.campId, plan.planId);
				check(
					status === null || !status.active,
					"an aborted shift left an active plan",
					"check the signal before applying",
				);
			},
		},
		options,
	);
}
