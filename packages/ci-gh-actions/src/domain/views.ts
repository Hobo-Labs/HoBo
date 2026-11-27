import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { GhMachinePool } from "./GhMachinePool.aggregate.js";
import { GhRelayJob } from "./GhRelayJob.aggregate.js";
import { GhRelayRouter } from "./GhRelayRouter.aggregate.js";
import {
	GhAccountId,
	GhHostedProviderKey,
	GhMachineId,
	GhMachineSharing,
	GhRepoSlug,
	GhRouteSkip,
	GhRunnerLabel,
	GhStepKey,
	NonEmptyReason,
	NonNegativeCount,
	PositiveSlots,
} from "./ids.js";

export const GhRelayActivityState = Schema.Union([
	Schema.TaggedStruct("Unobserved", {}),
	Schema.TaggedStruct("Queued", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		jobName: Schema.NonEmptyString,
		matrixLeg: Schema.NullOr(Schema.NonEmptyString),
	}),
	Schema.TaggedStruct("Claimed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		nodeId: Schema.NonEmptyString,
	}),
	Schema.TaggedStruct("Routed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		step: GhStepKey,
		runnerLabel: GhRunnerLabel,
		machineId: Schema.NullOr(GhMachineId),
		skipped: Schema.Array(GhRouteSkip),
		notInOrder: Schema.Array(GhStepKey),
	}),
	Schema.TaggedStruct("Waiting", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		step: GhStepKey,
		runnerLabel: GhRunnerLabel,
		machineId: Schema.NullOr(GhMachineId),
		skipped: Schema.Array(GhRouteSkip),
	}),
	Schema.TaggedStruct("CheckPassed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		summary: NonEmptyReason,
		annotations: Schema.Array(NonEmptyReason),
	}),
	Schema.TaggedStruct("CheckFailed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		summary: NonEmptyReason,
		annotations: Schema.Array(NonEmptyReason),
	}),
	Schema.TaggedStruct("RouteFailed", {
		accountId: Schema.NullOr(GhAccountId),
		repository: Schema.NullOr(GhRepoSlug),
		reason: NonEmptyReason,
		annotations: Schema.Array(NonEmptyReason),
	}),
	Schema.TaggedStruct("Expired", {
		accountId: Schema.NullOr(GhAccountId),
		repository: Schema.NullOr(GhRepoSlug),
		reason: NonEmptyReason,
	}),
]);
export type GhRelayActivityState = typeof GhRelayActivityState.Type;

type ActivityContext = Readonly<{
	accountId: GhAccountId | null;
	repository: GhRepoSlug | null;
}>;

function contextOf(view: GhRelayActivityState): ActivityContext {
	switch (view._tag) {
		case "Unobserved":
			return { accountId: null, repository: null };
		case "Queued":
		case "Claimed":
		case "Routed":
		case "Waiting":
		case "CheckPassed":
		case "CheckFailed":
		case "RouteFailed":
		case "Expired":
			return { accountId: view.accountId, repository: view.repository };
	}
}

export class GhRelayActivityView extends Domain.View(
	"GhRelayActivityView",
	{
		from: [GhRelayJob],
		key: GhRelayJob,
		state: GhRelayActivityState,
		initial: { _tag: "Unobserved" },
		evolve: {
			GhRelayJobQueued: (_view, event) => ({
				_tag: "Queued" as const,
				accountId: event.context.accountId,
				repository: event.context.repository,
				jobName: event.context.jobName,
				matrixLeg: event.context.matrixLeg,
			}),
			GhRelayJobClaimed: (_view, event) => ({
				_tag: "Claimed" as const,
				accountId: event.accountId,
				repository: event.repository,
				nodeId: event.nodeId,
			}),
			GhRelayJobRouted: (view, event) => {
				const ctx = contextOf(view);
				if (ctx.accountId === null || ctx.repository === null) return view;
				return {
					_tag: "Routed" as const,
					accountId: ctx.accountId,
					repository: ctx.repository,
					step: event.step,
					runnerLabel: event.runnerLabel,
					machineId: event.machineId,
					skipped: event.skipped,
					notInOrder: event.notInOrder,
				};
			},
			GhRelayJobWaiting: (view, event) => {
				const ctx = contextOf(view);
				if (ctx.accountId === null || ctx.repository === null) return view;
				return {
					_tag: "Waiting" as const,
					accountId: ctx.accountId,
					repository: ctx.repository,
					step: event.step,
					runnerLabel: event.runnerLabel,
					machineId: event.machineId,
					skipped: event.skipped,
				};
			},
			GhRelayCheckCompleted: (view, event) => {
				const ctx = contextOf(view);
				if (ctx.accountId === null || ctx.repository === null) return view;
				return {
					_tag: event.passed
						? ("CheckPassed" as const)
						: ("CheckFailed" as const),
					accountId: ctx.accountId,
					repository: ctx.repository,
					summary: event.summary,
					annotations: event.annotations,
				};
			},
			GhRelayJobFailed: (view, event) => {
				const ctx = contextOf(view);
				return {
					_tag: "RouteFailed" as const,
					accountId: ctx.accountId,
					repository: ctx.repository,
					reason: event.reason,
					annotations: event.annotations,
				};
			},
			GhRelayJobExpired: (view, event) => {
				const ctx = contextOf(view);
				return {
					_tag: "Expired" as const,
					accountId: ctx.accountId,
					repository: ctx.repository,
					reason: event.reason,
				};
			},
		},
	},
	{
		description:
			"Per-job GitHub Actions relay activity view showing where each job ran, skipped steps, and check annotations.",
	},
) {}

const MachineStatusEntry = Schema.Struct({
	machineId: GhMachineId,
	name: Schema.NonEmptyString,
	runsOnLabel: GhRunnerLabel,
	slots: PositiveSlots,
	busy: NonNegativeCount,
	paused: Schema.Boolean,
	sharing: GhMachineSharing,
	adopted: Schema.Boolean,
	takeoverCount: NonNegativeCount,
});
type MachineStatusEntry = typeof MachineStatusEntry.Type;

export const GhAccountStatusState = Schema.Struct({
	machines: Schema.Array(MachineStatusEntry),
	unhealthyProviders: Schema.Array(GhHostedProviderKey),
	routedCount: NonNegativeCount,
	waitingCount: NonNegativeCount,
	failedCount: NonNegativeCount,
	autoRetryCount: NonNegativeCount,
});
export type GhAccountStatusState = typeof GhAccountStatusState.Type;

const ZERO = NonNegativeCount.make(0);

function clampCount(value: number): NonNegativeCount {
	return NonNegativeCount.make(value <= 0 ? 0 : value);
}

export class GhAccountStatusView extends Domain.View(
	"GhAccountStatusView",
	{
		from: [GhMachinePool, GhRelayRouter],
		key: GhMachinePool,
		keyOf: {
			GhProviderHealthCleared: ({ source }) => GhMachinePool.ref(source.id),
			GhRouteDecisionRecorded: ({ source }) => GhMachinePool.ref(source.id),
			GhJobAutoRetryRecorded: ({ source }) => GhMachinePool.ref(source.id),
		},
		state: GhAccountStatusState,
		initial: {
			machines: [],
			unhealthyProviders: [],
			routedCount: ZERO,
			waitingCount: ZERO,
			failedCount: ZERO,
			autoRetryCount: ZERO,
		},
		evolve: {
			GhMachineConnected: (view, event) => {
				const existing = view.machines.find(
					(entry) => entry.machineId === event.machineId,
				);
				const next: MachineStatusEntry = {
					machineId: event.machineId,
					name: event.name,
					runsOnLabel: event.runsOnLabel,
					slots: event.slots,
					busy: existing?.busy ?? ZERO,
					paused: existing?.paused ?? false,
					sharing: event.sharing,
					adopted: event.adopted,
					takeoverCount: existing?.takeoverCount ?? ZERO,
				};
				return {
					...view,
					machines: existing
						? view.machines.map((entry) =>
								entry.machineId === event.machineId ? next : entry,
							)
						: [...view.machines, next],
				};
			},
			GhMachineTakenOver: (view, event) => ({
				...view,
				machines: view.machines.map((entry) =>
					entry.machineId === event.machineId
						? {
								...entry,
								takeoverCount: NonNegativeCount.make(entry.takeoverCount + 1),
							}
						: entry,
				),
			}),
			GhMachinePaused: (view, event) => ({
				...view,
				machines: view.machines.map((entry) =>
					entry.machineId === event.machineId
						? { ...entry, paused: true }
						: entry,
				),
			}),
			GhMachineResumed: (view, event) => ({
				...view,
				machines: view.machines.map((entry) =>
					entry.machineId === event.machineId
						? { ...entry, paused: false }
						: entry,
				),
			}),
			GhMachineRemoved: (view, event) => ({
				...view,
				machines: view.machines.filter(
					(entry) => entry.machineId !== event.machineId,
				),
			}),
			GhMachineSlotAcquired: (view, event) => ({
				...view,
				machines: view.machines.map((entry) =>
					entry.machineId === event.machineId
						? { ...entry, busy: NonNegativeCount.make(entry.busy + 1) }
						: entry,
				),
			}),
			GhMachineSlotReleased: (view, event) => ({
				...view,
				machines: view.machines.map((entry) =>
					entry.machineId === event.machineId
						? { ...entry, busy: clampCount(entry.busy - 1) }
						: entry,
				),
			}),
			GhProviderHealthCleared: (view, event) => ({
				...view,
				unhealthyProviders: view.unhealthyProviders.filter(
					(provider) => provider !== event.provider,
				),
			}),
			GhRouteDecisionRecorded: (view, event) => ({
				...view,
				routedCount:
					event.outcome === "routed"
						? NonNegativeCount.make(view.routedCount + 1)
						: view.routedCount,
				waitingCount:
					event.outcome === "waiting"
						? NonNegativeCount.make(view.waitingCount + 1)
						: view.waitingCount,
				failedCount:
					event.outcome === "failed"
						? NonNegativeCount.make(view.failedCount + 1)
						: view.failedCount,
			}),
			GhJobAutoRetryRecorded: (view) => ({
				...view,
				autoRetryCount: NonNegativeCount.make(view.autoRetryCount + 1),
			}),
		},
	},
	{
		description:
			"Per-account GitHub Actions relay status summarizing connected machines, slot occupancy, takeovers, and routing outcomes.",
	},
) {}
