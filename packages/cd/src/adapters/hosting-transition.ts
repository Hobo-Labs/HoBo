import { create } from "@bufbuild/protobuf";
import {
	createHostingTransitionCoordinator,
	HostingTransitionAction,
	type HostingTransitionCoordinatorOptions,
	HostingTransitionPhase,
	type HostingTransitionPlanInput,
	type HostingTransitionProvider,
	type HostingTransitionState,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import type { DurableEventStore } from "@hobo/core";
import {
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	ResourceObservationSchema,
} from "../_generated/cd_pb.js";
import type { CdContext, RealizeInput, Realizer } from "../ports.js";
import { reason } from "../reconcile/errors.js";

export type HostingCoordinator = Readonly<{
	propose(input: HostingTransitionPlanInput): Promise<HostingTransitionState>;
	reserve(transitionId: string): Promise<HostingTransitionState>;
	dispatch(transitionId: string): Promise<HostingTransitionState>;
	observe(transitionId: string): Promise<HostingTransitionState>;
	load(transitionId: string): Promise<HostingTransitionState | undefined>;
}>;

export type HostingTransitionRealizerDeps = Readonly<{
	store: DurableEventStore;
	budget: SharedHostingBudgetAuthority;
	provider: HostingTransitionProvider;
	tenant: string;
	now: () => number;
	authorize: HostingTransitionCoordinatorOptions["authorize"];
	planFor: (
		input: RealizeInput,
	) =>
		| HostingTransitionPlanInput
		| undefined
		| Promise<HostingTransitionPlanInput | undefined>;
	coordinator?: (
		options: HostingTransitionCoordinatorOptions,
	) => HostingCoordinator;
	maxSteps?: number;
}>;

export const HOSTING_TRANSITION_KIND = "hosting-transition" as const;

function isRead(action: HostingTransitionAction | undefined): boolean {
	return (
		action === HostingTransitionAction.VERIFY ||
		action === HostingTransitionAction.SETTLE
	);
}

export type TransitionVerdict = Readonly<{
	status: ReconcileStatus;
	reasons: readonly ReasonRecord[];
}>;

const CONVERGING: TransitionVerdict = Object.freeze({
	status: ReconcileStatus.CONVERGING,
	reasons: Object.freeze([]),
});
const CONVERGED: TransitionVerdict = Object.freeze({
	status: ReconcileStatus.CONVERGED,
	reasons: Object.freeze([]),
});

function blockedVerdict(message: string, subject: string): TransitionVerdict {
	return Object.freeze({
		status: ReconcileStatus.BLOCKED,
		reasons: Object.freeze([reason("realize-blocked", message, subject)]),
	});
}

export function transitionStatus(
	state: HostingTransitionState | undefined,
): TransitionVerdict {
	if (!state) return CONVERGING;
	const subject = state.plan?.transitionId ?? "";
	if (state.phase === HostingTransitionPhase.SETTLED) {
		if (state.restorationConfirmed || !state.destinationOwnsWrites)
			return blockedVerdict(
				"hosting transition settled back on its source; the new version did not take effect",
				subject,
			);
		return CONVERGED;
	}
	if (
		state.phase === HostingTransitionPhase.BLOCKED ||
		state.phase === HostingTransitionPhase.RESTORED
	)
		return blockedVerdict(
			state.phase === HostingTransitionPhase.RESTORED
				? "The hosting transition restored the source; the new version did not take effect."
				: "The hosting transition is blocked.",
			subject,
		);
	return CONVERGING;
}

function observationFor(
	input: RealizeInput,
	plan: HostingTransitionPlanInput | undefined,
	state: HostingTransitionState | undefined,
	extra: readonly ReasonRecord[] = [],
): ReconcileObservationRecord {
	const mapped = plan ? transitionStatus(state) : CONVERGED;
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId:
			mapped.status === ReconcileStatus.CONVERGED ? input.desired.setId : "",
		reconcilerId: input.reconcilerId,
		fenceToken: input.fence.toString(10),
		status: extra.length > 0 ? ReconcileStatus.BLOCKED : mapped.status,
		reasons: [...mapped.reasons, ...extra],
		resources: plan
			? [
					create(ResourceObservationSchema, {
						resource: plan.deploymentId ?? "",
						physicalId: plan.transitionId ?? "",
						kind: HOSTING_TRANSITION_KIND,
						healthy: mapped.status === ReconcileStatus.CONVERGED,
					}),
				]
			: [],
	});
}

export function createHostingTransitionRealizer(
	d: HostingTransitionRealizerDeps,
): Realizer {
	const factory = d.coordinator ?? createHostingTransitionCoordinator;
	const maxSteps = d.maxSteps ?? 8;

	function coordinatorFor(input: RealizeInput): HostingCoordinator {
		return factory({
			store: d.store,
			budget: d.budget,
			provider: d.provider,
			context: {
				tenantId: d.tenant,
				actor: { kind: "service", id: `cd-reconciler:${input.reconcilerId}` },
				fenceToken: input.fence,
			},
			nowMs: d.now,
			authorize: d.authorize,
		});
	}

	return Object.freeze({
		async observe(input: RealizeInput, _ctx: CdContext) {
			const plan = await d.planFor(input);
			if (!plan?.transitionId)
				return observationFor(input, undefined, undefined);
			try {
				const state = await coordinatorFor(input).load(plan.transitionId);
				return observationFor(input, plan, state);
			} catch {
				return observationFor(input, plan, undefined, [
					reason(
						"realize-failed",
						"The hosting transition could not complete.",
						input.campId,
					),
				]);
			}
		},
		async converge(input: RealizeInput, _ctx: CdContext) {
			const plan = await d.planFor(input);
			if (!plan?.transitionId)
				return observationFor(input, undefined, undefined);
			const id = plan.transitionId;
			try {
				const coordinator = coordinatorFor(input);
				let state = await coordinator.propose(plan);
				for (let step = 0; step < maxSteps; step += 1) {
					const phase = state.phase;
					if (transitionStatus(state).status !== ReconcileStatus.CONVERGING)
						break;
					const before = state.version;
					if (
						phase === HostingTransitionPhase.PROPOSED ||
						phase === HostingTransitionPhase.RESERVING
					)
						state = await coordinator.reserve(id);
					else if (
						state.operation &&
						!state.operation.mutationDispatched &&
						!isRead(state.operation.action)
					)
						state = await coordinator.dispatch(id);
					else state = await coordinator.observe(id);
					if (state.version === before && state.phase === phase) break;
				}
				return observationFor(input, plan, state);
			} catch {
				return observationFor(input, plan, undefined, [
					reason(
						"realize-failed",
						"The hosting transition could not complete.",
						input.campId,
					),
				]);
			}
		},
	} satisfies Realizer);
}
