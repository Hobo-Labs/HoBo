import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	EpochMs,
	GhAccountId,
	GhDeliveryId,
	GhFleetSnapshot,
	GhHostedProviderKey,
	GhJobContext,
	GhMachineId,
	GhMachineSnapshot,
	GhRelayJobId,
	GhRepoSlug,
	GhRouteSkip,
	type GhRouteStepConfig,
	GhRunnerLabel,
	GhRunnerOrderConfig,
	type GhStepCandidate,
	GhStepKey,
	NonEmptyReason,
	NonNegativeCents,
	NonNegativeCount,
	NonNegativeMinutes,
	PositiveRunId,
} from "./ids.js";
import {
	isGhGithubHostedLabel,
	isGhHostedProviderKey,
	isGhProviderLabel,
	parseGhRunsOn,
	resolveGhAutoLabel,
} from "./runs-on.js";

const HEALTH_WINDOW_MS = 30 * 60_000;
const HEALTH_MISS_THRESHOLD = 3;
const INITIAL_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const RUNWAY_HOURS = 2;

export class GhRetryLimitReached extends Domain.Rejection(
	"GhRetryLimitReached",
	{
		runId: PositiveRunId,
		jobName: Schema.NonEmptyString,
		retriesUsed: NonNegativeCount,
		maxRetries: Schema.Literals([1, 2]),
	},
) {}

export class GhRetryDisabled extends Domain.Rejection("GhRetryDisabled", {
	repository: GhRepoSlug,
}) {}

export class GhRunnerOrderConfigured extends Domain.Event(
	"GhRunnerOrderConfigured",
	{
		repository: GhRepoSlug,
		order: GhRunnerOrderConfig,
	},
) {}

export class GhMinutesUsageSynced extends Domain.Event("GhMinutesUsageSynced", {
	usedMinutes: Schema.NullOr(NonNegativeMinutes),
	includedMinutes: NonNegativeMinutes,
	burnPerHour: Schema.NullOr(NonNegativeMinutes),
}) {}

export class GhProviderSpendSynced extends Domain.Event(
	"GhProviderSpendSynced",
	{
		provider: GhHostedProviderKey,
		spentCents: Schema.NullOr(NonNegativeCents),
	},
) {}

export class GhProviderMissRecorded extends Domain.Event(
	"GhProviderMissRecorded",
	{
		provider: GhHostedProviderKey,
		atMs: EpochMs,
	},
) {}

export class GhProviderHealthCleared extends Domain.Event(
	"GhProviderHealthCleared",
	{
		provider: GhHostedProviderKey,
	},
) {}

export class GhProviderTrialStarted extends Domain.Event(
	"GhProviderTrialStarted",
	{
		provider: GhHostedProviderKey,
		atMs: EpochMs,
	},
) {}

export class GhRouteDecisionRecorded extends Domain.Event(
	"GhRouteDecisionRecorded",
	{
		jobId: GhRelayJobId,
		repository: GhRepoSlug,
		outcome: Schema.Literals(["routed", "waiting", "failed"]),
		step: Schema.NullOr(GhStepKey),
		runnerLabel: Schema.NullOr(GhRunnerLabel),
		machineId: Schema.NullOr(GhMachineId),
		reason: NonEmptyReason,
		skipped: Schema.Array(GhRouteSkip),
		notInOrder: Schema.Array(GhStepKey),
		decidedAtMs: EpochMs,
	},
) {}

export class GhJobAutoRetryRecorded extends Domain.Event(
	"GhJobAutoRetryRecorded",
	{
		repository: GhRepoSlug,
		runId: PositiveRunId,
		jobName: Schema.NonEmptyString,
		deliveryId: GhDeliveryId,
		attemptNumber: NonNegativeCount,
	},
) {}

export class ConfigureGhRunnerOrder extends Domain.Command(
	"ConfigureGhRunnerOrder",
	{
		target: GhAccountId,
		input: {
			repository: GhRepoSlug,
			order: GhRunnerOrderConfig,
		},
		events: [GhRunnerOrderConfigured],
		rejects: [],
	},
	{
		description:
			"Commit a strict runner order configuration for a GitHub repository.",
	},
) {}

export class SyncGhMinutesUsage extends Domain.Command(
	"SyncGhMinutesUsage",
	{
		target: GhAccountId,
		input: {
			usedMinutes: Schema.NullOr(NonNegativeMinutes),
			includedMinutes: NonNegativeMinutes,
			burnPerHour: Schema.NullOr(NonNegativeMinutes),
		},
		events: [GhMinutesUsageSynced],
		rejects: [],
	},
	{
		description:
			"Record measured GitHub Actions minutes and burn rate; null means unmeasured and never blocks.",
	},
) {}

export class SyncGhProviderSpend extends Domain.Command(
	"SyncGhProviderSpend",
	{
		target: GhAccountId,
		input: {
			provider: GhHostedProviderKey,
			spentCents: Schema.NullOr(NonNegativeCents),
		},
		events: [GhProviderSpendSynced],
		rejects: [],
	},
	{
		description:
			"Sync monthly spend in cents for a hosted runner provider from ledger or provider usage API.",
	},
) {}

export class RecordGhProviderMiss extends Domain.Command(
	"RecordGhProviderMiss",
	{
		target: GhAccountId,
		input: {
			provider: GhHostedProviderKey,
			atMs: EpochMs,
		},
		events: [GhProviderMissRecorded],
		rejects: [],
	},
	{
		description:
			"Record a missed job start for a hosted provider; three misses within thirty minutes trip its circuit breaker.",
	},
) {}

export class ClearGhProviderHealth extends Domain.Command(
	"ClearGhProviderHealth",
	{
		target: GhAccountId,
		input: {
			provider: GhHostedProviderKey,
		},
		events: [GhProviderHealthCleared],
		rejects: [],
	},
	{
		description:
			"Manually clear an unhealthy hosted provider circuit breaker so jobs route to it again.",
	},
) {}

export class RouteGhJob extends Domain.Command(
	"RouteGhJob",
	{
		target: GhAccountId,
		input: {
			jobId: GhRelayJobId,
			context: GhJobContext,
			machines: Schema.Array(GhMachineSnapshot),
			fleet: Schema.NullOr(GhFleetSnapshot),
		},
		events: [GhProviderTrialStarted, GhRouteDecisionRecorded],
		rejects: [],
		reply: {
			outcome: Schema.Literals(["routed", "waiting", "failed"]),
			step: Schema.NullOr(GhStepKey),
			runnerLabel: Schema.NullOr(GhRunnerLabel),
			machineId: Schema.NullOr(GhMachineId),
			reason: NonEmptyReason,
			skipped: Schema.Array(GhRouteSkip),
			notInOrder: Schema.Array(GhStepKey),
		},
	},
	{
		description:
			"Walk the repository runner order for a GitHub Actions job using runs-on or relay inputs and live account facts.",
	},
) {}

export class RequestGhJobAutoRetry extends Domain.Command(
	"RequestGhJobAutoRetry",
	{
		target: GhAccountId,
		input: {
			repository: GhRepoSlug,
			runId: PositiveRunId,
			jobName: Schema.NonEmptyString,
			deliveryId: GhDeliveryId,
		},
		events: [GhJobAutoRetryRecorded],
		rejects: [GhRetryDisabled, GhRetryLimitReached],
		reply: {
			shouldRerun: Schema.Boolean,
			attemptNumber: NonNegativeCount,
		},
	},
	{
		description:
			"Record an idempotent automatic retry for an infrastructure-failed job, bounded to max two retries and deduplicated per delivery.",
	},
) {}

const RepoOrderEntry = Schema.Struct({
	repository: GhRepoSlug,
	order: GhRunnerOrderConfig,
});

const ProviderSpendEntry = Schema.Struct({
	provider: GhHostedProviderKey,
	spentCents: Schema.NullOr(NonNegativeCents),
});

const ProviderHealthEntry = Schema.Struct({
	provider: GhHostedProviderKey,
	missTimestamps: Schema.Array(EpochMs),
	trippedAtMs: Schema.NullOr(EpochMs),
	backoffMs: NonNegativeCount,
	nextTrialAtMs: Schema.NullOr(EpochMs),
});
type ProviderHealthEntry = typeof ProviderHealthEntry.Type;

const RetryHistoryEntry = Schema.Struct({
	runId: PositiveRunId,
	jobName: Schema.NonEmptyString,
	deliveryIds: Schema.Array(GhDeliveryId),
});

export const GhRelayRouterState = Schema.Struct({
	orders: Schema.Array(RepoOrderEntry),
	minutesUsed: Schema.NullOr(NonNegativeMinutes),
	minutesIncluded: NonNegativeMinutes,
	burnPerHour: Schema.NullOr(NonNegativeMinutes),
	providerSpend: Schema.Array(ProviderSpendEntry),
	providerHealth: Schema.Array(ProviderHealthEntry),
	retries: Schema.Array(RetryHistoryEntry),
});
export type GhRelayRouterState = typeof GhRelayRouterState.Type;

function orderFor(
	state: GhRelayRouterState,
	repository: GhRepoSlug,
): GhRunnerOrderConfig | null {
	return (
		state.orders.find(
			(entry) => entry.repository.toLowerCase() === repository.toLowerCase(),
		)?.order ?? null
	);
}

function notConfiguredFailure(
	candidates: readonly GhStepCandidate[],
): readonly GhRouteSkip[] {
	if (candidates.length > 0) {
		return candidates.map((candidate) => ({
			step: candidate.step,
			reason: "not_configured" as const,
			detail: "",
		}));
	}
	return [{ step: "github", reason: "not_configured", detail: "" }];
}

function orderedStepsWithFirst(
	steps: readonly GhRouteStepConfig[],
	first: GhStepKey | null,
): readonly GhRouteStepConfig[] {
	if (first === null) return steps;
	const preferred = steps.filter((step) => step.key === first);
	if (preferred.length === 0) return steps;
	const rest = steps.filter((step) => step.key !== first);
	return [...preferred, ...rest];
}

type EffectiveCandidates = Readonly<{
	candidates: readonly GhStepCandidate[];
	first: GhStepKey | null;
	size: GhJobContext["size"];
}>;

function effectiveCandidates(context: GhJobContext): EffectiveCandidates {
	if (context.candidates.length > 0) {
		return {
			candidates: context.candidates,
			first: context.first,
			size: context.size,
		};
	}
	const parsed = parseGhRunsOn(context.runsOn);
	if (parsed.ok && parsed.kind === "route") {
		return {
			candidates: parsed.candidates,
			first: context.first ?? parsed.first,
			size: context.size ?? parsed.size,
		};
	}
	if (parsed.ok && parsed.kind === "fleet") {
		return {
			candidates: parsed.candidates,
			first: context.first,
			size: context.size,
		};
	}
	return {
		candidates: [],
		first: context.first,
		size: context.size,
	};
}

function machineHasAllLabels(
	machine: GhMachineSnapshot,
	requested: readonly GhRunnerLabel[],
): boolean {
	const held = new Set(machine.labels.map((label) => label.toLowerCase()));
	for (const label of requested) {
		const lower = label.toLowerCase();
		if (lower === "self-hosted") continue;
		if (!held.has(lower)) return false;
	}
	return true;
}

function healthStatusOf(
	entry: ProviderHealthEntry | undefined,
	nowMs: number,
): "healthy" | "unhealthy" | "trial" {
	if (entry === undefined || entry.trippedAtMs === null) return "healthy";
	if (entry.nextTrialAtMs !== null && nowMs >= entry.nextTrialAtMs) {
		return "trial";
	}
	return "unhealthy";
}

function describeFailure(
	repository: GhRepoSlug,
	skipped: readonly GhRouteSkip[],
): NonEmptyReason {
	if (skipped.length === 0) {
		return NonEmptyReason.make(
			`No runner in the runner order of ${repository} matched the job's requested runner types.`,
		);
	}
	const details = skipped.map((entry) => `${entry.step} (${entry.reason})`);
	return NonEmptyReason.make(
		`No runner could take this job for ${repository}: ${details.join(", ")}.`,
	);
}

export class GhRelayRouter extends Domain.Aggregate("GhRelayRouter", {
	id: GhAccountId,
	state: GhRelayRouterState,
	initial: {
		orders: [],
		minutesUsed: null,
		minutesIncluded: NonNegativeMinutes.make(2_000),
		burnPerHour: null,
		providerSpend: [],
		providerHealth: [],
		retries: [],
	},
	commands: [
		ConfigureGhRunnerOrder,
		SyncGhMinutesUsage,
		SyncGhProviderSpend,
		RecordGhProviderMiss,
		ClearGhProviderHealth,
		RouteGhJob,
		RequestGhJobAutoRetry,
	],
	decide: {
		ConfigureGhRunnerOrder: (_state, cmd) => [
			new GhRunnerOrderConfigured({
				repository: cmd.repository,
				order: cmd.order,
			}),
		],
		SyncGhMinutesUsage: (_state, cmd) => [
			new GhMinutesUsageSynced({
				usedMinutes: cmd.usedMinutes,
				includedMinutes: cmd.includedMinutes,
				burnPerHour: cmd.burnPerHour,
			}),
		],
		SyncGhProviderSpend: (_state, cmd) => [
			new GhProviderSpendSynced({
				provider: cmd.provider,
				spentCents: cmd.spentCents,
			}),
		],
		RecordGhProviderMiss: (_state, cmd) => [
			new GhProviderMissRecorded({
				provider: cmd.provider,
				atMs: cmd.atMs,
			}),
		],
		ClearGhProviderHealth: (_state, cmd) => [
			new GhProviderHealthCleared({
				provider: cmd.provider,
			}),
		],
		RouteGhJob: (state, cmd) => {
			const order = orderFor(state, cmd.context.repository);
			const { candidates, first, size } = effectiveCandidates(cmd.context);
			if (order === null) {
				const skipped = notConfiguredFailure(candidates);
				return [
					new GhRouteDecisionRecorded({
						jobId: cmd.jobId,
						repository: cmd.context.repository,
						outcome: "failed",
						step: null,
						runnerLabel: null,
						machineId: null,
						reason: describeFailure(cmd.context.repository, skipped),
						skipped,
						notInOrder: [],
						decidedAtMs: cmd.context.nowMs,
					}),
				];
			}
			const candidateByStep = new Map<GhStepKey, readonly GhRunnerLabel[]>(
				candidates.map((candidate) => [candidate.step, candidate.labels]),
			);
			const orderKeys = new Set(order.steps.map((step) => step.key));
			const notInOrder = candidates
				.map((candidate) => candidate.step)
				.filter((key) => !orderKeys.has(key));

			const skipped: GhRouteSkip[] = [];
			const trialEvents: GhProviderTrialStarted[] = [];
			let busyFallback:
				| {
						readonly step: GhStepKey;
						readonly runnerLabel: GhRunnerLabel;
						readonly machineId: GhMachineId | null;
				  }
				| undefined;

			const steps = orderedStepsWithFirst(order.steps, first);
			const effectiveSize = size ?? order.autoSizeVcpus;

			for (const step of steps) {
				const rawLabels = candidateByStep.get(step.key);
				if (rawLabels === undefined || rawLabels.length === 0) {
					continue;
				}

				if (step.key === "fleet") {
					if (cmd.fleet === null || !cmd.fleet.enabled) {
						skipped.push({ step: "fleet", reason: "fleet_off", detail: "" });
						continue;
					}
					if (
						(!cmd.context.isPrivate || cmd.context.isFork) &&
						!cmd.fleet.isolated
					) {
						skipped.push({
							step: "fleet",
							reason: "needs_isolation",
							detail: "",
						});
						continue;
					}
					const label = rawLabels[0];
					if (rawLabels.length !== 1 || label === undefined) {
						skipped.push({
							step: "fleet",
							reason: "too_many_labels",
							detail: rawLabels.join(", "),
						});
						continue;
					}
					if (cmd.fleet.taking) {
						return [
							...trialEvents,
							new GhRouteDecisionRecorded({
								jobId: cmd.jobId,
								repository: cmd.context.repository,
								outcome: "routed",
								step: "fleet",
								runnerLabel: label,
								machineId: null,
								reason: NonEmptyReason.make(`Routed to ${label} (fleet).`),
								skipped,
								notInOrder,
								decidedAtMs: cmd.context.nowMs,
							}),
						];
					}
					skipped.push({ step: "fleet", reason: "fleet_full", detail: "" });
					busyFallback ??= {
						step: "fleet",
						runnerLabel: label,
						machineId: null,
					};
					continue;
				}

				if (step.key === "machine") {
					if (!cmd.context.isPrivate) {
						skipped.push({
							step: "machine",
							reason: "public_repository",
							detail: "",
						});
						continue;
					}
					if (cmd.context.isFork) {
						skipped.push({
							step: "machine",
							reason: "fork_pull_request",
							detail: "",
						});
						continue;
					}
					const matching = cmd.machines.filter(
						(machine) =>
							machine.online && machineHasAllLabels(machine, rawLabels),
					);
					if (matching.length === 0) {
						skipped.push({
							step: "machine",
							reason: "no_machine",
							detail: rawLabels.join(", "),
						});
						continue;
					}
					const shared = matching.filter((machine) =>
						machine.sharing === "anyone"
							? machine.ownerCanRead
							: machine.ownerId === cmd.context.actorId && machine.ownerCanRead,
					);
					if (shared.length === 0) {
						skipped.push({
							step: "machine",
							reason: "machine_not_shared",
							detail: matching[0]?.name ?? "",
						});
						continue;
					}
					const active = shared.filter((machine) => !machine.paused);
					if (active.length === 0) {
						skipped.push({
							step: "machine",
							reason: "machine_paused",
							detail: shared[0]?.name ?? "",
						});
						continue;
					}
					const free = active.find((machine) => machine.busy < machine.slots);
					if (free !== undefined) {
						return [
							...trialEvents,
							new GhRouteDecisionRecorded({
								jobId: cmd.jobId,
								repository: cmd.context.repository,
								outcome: "routed",
								step: "machine",
								runnerLabel: free.runsOnLabel,
								machineId: free.machineId,
								reason: NonEmptyReason.make(
									`Routed to ${free.runsOnLabel} (machine ${free.name}).`,
								),
								skipped,
								notInOrder,
								decidedAtMs: cmd.context.nowMs,
							}),
						];
					}
					const busyMachine = active[0];
					if (busyMachine !== undefined) {
						skipped.push({
							step: "machine",
							reason: "machine_full",
							detail: busyMachine.name,
						});
						busyFallback ??= {
							step: "machine",
							runnerLabel: busyMachine.runsOnLabel,
							machineId: busyMachine.machineId,
						};
					}
					continue;
				}

				if (step.key === "github") {
					const raw = rawLabels[0];
					if (rawLabels.length !== 1 || raw === undefined) {
						skipped.push({
							step: "github",
							reason: "too_many_labels",
							detail: rawLabels.join(", "),
						});
						continue;
					}
					const resolved =
						raw.toLowerCase() === "auto"
							? resolveGhAutoLabel("github", effectiveSize, cmd.context.runId)
							: raw;
					if (resolved === undefined || !isGhGithubHostedLabel(resolved)) {
						skipped.push({
							step: "github",
							reason: "not_provider_label",
							detail: raw,
						});
						continue;
					}
					if (
						step.minutesLimitPercent !== null &&
						state.minutesUsed !== null &&
						state.minutesIncluded > 0
					) {
						const cap =
							(state.minutesIncluded * step.minutesLimitPercent) / 100;
						if (state.minutesUsed >= cap) {
							skipped.push({
								step: "github",
								reason: "minutes_limit",
								detail: `${state.minutesUsed}/${cap}`,
							});
							continue;
						}
						if (
							state.burnPerHour !== null &&
							state.minutesUsed + state.burnPerHour * RUNWAY_HOURS >= cap
						) {
							skipped.push({
								step: "github",
								reason: "minutes_runway",
								detail: `${state.minutesUsed}+2h>=${cap}`,
							});
							continue;
						}
					}
					return [
						...trialEvents,
						new GhRouteDecisionRecorded({
							jobId: cmd.jobId,
							repository: cmd.context.repository,
							outcome: "routed",
							step: "github",
							runnerLabel: resolved,
							machineId: null,
							reason: NonEmptyReason.make(`Routed to ${resolved} (github).`),
							skipped,
							notInOrder,
							decidedAtMs: cmd.context.nowMs,
						}),
					];
				}

				if (isGhHostedProviderKey(step.key)) {
					const provider = step.key;
					const raw = rawLabels[0];
					if (rawLabels.length !== 1 || raw === undefined) {
						skipped.push({
							step: provider,
							reason: "too_many_labels",
							detail: rawLabels.join(", "),
						});
						continue;
					}
					const resolved =
						raw.toLowerCase() === "auto"
							? resolveGhAutoLabel(provider, effectiveSize, cmd.context.runId)
							: raw;
					if (resolved === undefined) {
						skipped.push({
							step: provider,
							reason: "no_size",
							detail: String(effectiveSize),
						});
						continue;
					}
					if (!isGhProviderLabel(provider, resolved)) {
						skipped.push({
							step: provider,
							reason: "not_provider_label",
							detail: resolved,
						});
						continue;
					}
					if (step.spendLimitCents !== null) {
						const spent =
							state.providerSpend.find((entry) => entry.provider === provider)
								?.spentCents ?? null;
						if (spent !== null && spent >= step.spendLimitCents) {
							skipped.push({
								step: provider,
								reason: "spend_limit",
								detail: `${spent}/${step.spendLimitCents}`,
							});
							continue;
						}
					}
					if (order.skipUnhealthy) {
						const health = state.providerHealth.find(
							(entry) => entry.provider === provider,
						);
						const status = healthStatusOf(health, cmd.context.nowMs);
						if (status === "unhealthy") {
							skipped.push({
								step: provider,
								reason: "provider_unhealthy",
								detail: provider,
							});
							continue;
						}
						if (status === "trial") {
							trialEvents.push(
								new GhProviderTrialStarted({
									provider,
									atMs: cmd.context.nowMs,
								}),
							);
						}
					}
					return [
						...trialEvents,
						new GhRouteDecisionRecorded({
							jobId: cmd.jobId,
							repository: cmd.context.repository,
							outcome: "routed",
							step: provider,
							runnerLabel: resolved,
							machineId: null,
							reason: NonEmptyReason.make(
								`Routed to ${resolved} (${provider}).`,
							),
							skipped,
							notInOrder,
							decidedAtMs: cmd.context.nowMs,
						}),
					];
				}
			}

			if (busyFallback !== undefined) {
				return [
					...trialEvents,
					new GhRouteDecisionRecorded({
						jobId: cmd.jobId,
						repository: cmd.context.repository,
						outcome: "waiting",
						step: busyFallback.step,
						runnerLabel: busyFallback.runnerLabel,
						machineId: busyFallback.machineId,
						reason: NonEmptyReason.make(
							`Waiting for busy runner ${busyFallback.runnerLabel} (${busyFallback.step}).`,
						),
						skipped,
						notInOrder,
						decidedAtMs: cmd.context.nowMs,
					}),
				];
			}

			return [
				...trialEvents,
				new GhRouteDecisionRecorded({
					jobId: cmd.jobId,
					repository: cmd.context.repository,
					outcome: "failed",
					step: null,
					runnerLabel: null,
					machineId: null,
					reason: describeFailure(cmd.context.repository, skipped),
					skipped,
					notInOrder,
					decidedAtMs: cmd.context.nowMs,
				}),
			];
		},
		RequestGhJobAutoRetry: (state, cmd) => {
			const order = orderFor(state, cmd.repository);
			if (order === null) {
				return new GhRetryDisabled({ repository: cmd.repository });
			}
			if (order.retry === null || !order.retry.enabled) {
				return new GhRetryDisabled({ repository: cmd.repository });
			}
			const existing = state.retries.find(
				(entry) => entry.runId === cmd.runId && entry.jobName === cmd.jobName,
			);
			if (existing?.deliveryIds.includes(cmd.deliveryId)) {
				return [];
			}
			const used = existing?.deliveryIds.length ?? 0;
			if (used >= order.retry.maxRetries) {
				return new GhRetryLimitReached({
					runId: cmd.runId,
					jobName: cmd.jobName,
					retriesUsed: NonNegativeCount.make(used),
					maxRetries: order.retry.maxRetries,
				});
			}
			return [
				new GhJobAutoRetryRecorded({
					repository: cmd.repository,
					runId: cmd.runId,
					jobName: cmd.jobName,
					deliveryId: cmd.deliveryId,
					attemptNumber: NonNegativeCount.make(used + 1),
				}),
			];
		},
	},
	evolve: {
		GhRunnerOrderConfigured: (state, event) => {
			const exists = state.orders.some(
				(entry) =>
					entry.repository.toLowerCase() === event.repository.toLowerCase(),
			);
			const next = { repository: event.repository, order: event.order };
			return {
				...state,
				orders: exists
					? state.orders.map((entry) =>
							entry.repository.toLowerCase() === event.repository.toLowerCase()
								? next
								: entry,
						)
					: [...state.orders, next],
			};
		},
		GhMinutesUsageSynced: (state, event) => ({
			...state,
			minutesUsed: event.usedMinutes,
			minutesIncluded: event.includedMinutes,
			burnPerHour: event.burnPerHour,
		}),
		GhProviderSpendSynced: (state, event) => {
			const exists = state.providerSpend.some(
				(entry) => entry.provider === event.provider,
			);
			const next = { provider: event.provider, spentCents: event.spentCents };
			return {
				...state,
				providerSpend: exists
					? state.providerSpend.map((entry) =>
							entry.provider === event.provider ? next : entry,
						)
					: [...state.providerSpend, next],
			};
		},
		GhProviderMissRecorded: (state, event) => {
			const existing = state.providerHealth.find(
				(entry) => entry.provider === event.provider,
			);
			const recent = [
				...(existing?.missTimestamps ?? []).filter(
					(atMs) => event.atMs - atMs <= HEALTH_WINDOW_MS,
				),
				event.atMs,
			];
			const tripped =
				existing?.trippedAtMs !== null && existing?.trippedAtMs !== undefined
					? existing.trippedAtMs
					: recent.length >= HEALTH_MISS_THRESHOLD
						? event.atMs
						: null;
			const nextBackoff =
				tripped === null
					? NonNegativeCount.make(0)
					: existing?.trippedAtMs !== null &&
							existing?.trippedAtMs !== undefined
						? NonNegativeCount.make(
								Math.min(
									MAX_BACKOFF_MS,
									Math.max(INITIAL_BACKOFF_MS, existing.backoffMs * 2),
								),
							)
						: NonNegativeCount.make(INITIAL_BACKOFF_MS);
			const nextEntry: ProviderHealthEntry = {
				provider: event.provider,
				missTimestamps: recent,
				trippedAtMs: tripped,
				backoffMs: nextBackoff,
				nextTrialAtMs:
					tripped === null ? null : EpochMs.make(event.atMs + nextBackoff),
			};
			return {
				...state,
				providerHealth: existing
					? state.providerHealth.map((entry) =>
							entry.provider === event.provider ? nextEntry : entry,
						)
					: [...state.providerHealth, nextEntry],
			};
		},
		GhProviderHealthCleared: (state, event) => ({
			...state,
			providerHealth: state.providerHealth.filter(
				(entry) => entry.provider !== event.provider,
			),
		}),
		GhProviderTrialStarted: (state, event) => ({
			...state,
			providerHealth: state.providerHealth.map((entry) =>
				entry.provider === event.provider
					? {
							...entry,
							nextTrialAtMs: EpochMs.make(
								event.atMs + Math.max(INITIAL_BACKOFF_MS, entry.backoffMs),
							),
						}
					: entry,
			),
		}),
		GhRouteDecisionRecorded: (state) => state,
		GhJobAutoRetryRecorded: (state, event) => {
			const existing = state.retries.find(
				(entry) =>
					entry.runId === event.runId && entry.jobName === event.jobName,
			);
			if (existing === undefined) {
				return {
					...state,
					retries: [
						...state.retries,
						{
							runId: event.runId,
							jobName: event.jobName,
							deliveryIds: [event.deliveryId],
						},
					],
				};
			}
			return {
				...state,
				retries: state.retries.map((entry) =>
					entry.runId === event.runId && entry.jobName === event.jobName
						? {
								...entry,
								deliveryIds: [...entry.deliveryIds, event.deliveryId],
							}
						: entry,
				),
			};
		},
	},
	reply: {
		RouteGhJob: (_state, events) => {
			const decided = events.find(
				(event): event is GhRouteDecisionRecorded =>
					event._tag === "GhRouteDecisionRecorded",
			);
			return {
				outcome: decided?.outcome ?? "failed",
				step: decided?.step ?? null,
				runnerLabel: decided?.runnerLabel ?? null,
				machineId: decided?.machineId ?? null,
				reason: decided?.reason ?? NonEmptyReason.make("No route recorded."),
				skipped: decided?.skipped ?? [],
				notInOrder: decided?.notInOrder ?? [],
			};
		},
		RequestGhJobAutoRetry: (state, events) => {
			const recorded = events.find(
				(event): event is GhJobAutoRetryRecorded =>
					event._tag === "GhJobAutoRetryRecorded",
			);
			if (recorded !== undefined) {
				return {
					shouldRerun: true,
					attemptNumber: recorded.attemptNumber,
				};
			}
			const existingCount = state.retries.at(-1)?.deliveryIds.length ?? 0;
			return {
				shouldRerun: false,
				attemptNumber: NonNegativeCount.make(existingCount),
			};
		},
	},
}) {}
