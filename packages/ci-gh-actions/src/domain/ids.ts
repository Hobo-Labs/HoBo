import * as Schema from "effect/Schema";

export const GhAccountId = Schema.NonEmptyString.pipe(
	Schema.brand("GhAccountId"),
);
export type GhAccountId = typeof GhAccountId.Type;

export const GhRepoSlug = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u),
).pipe(Schema.brand("GhRepoSlug"));
export type GhRepoSlug = typeof GhRepoSlug.Type;

export const GhRelayJobId = Schema.NonEmptyString.pipe(
	Schema.brand("GhRelayJobId"),
);
export type GhRelayJobId = typeof GhRelayJobId.Type;

export const GhMachineId = Schema.NonEmptyString.pipe(
	Schema.brand("GhMachineId"),
);
export type GhMachineId = typeof GhMachineId.Type;

export const GhRunnerLabel = Schema.NonEmptyString.pipe(
	Schema.brand("GhRunnerLabel"),
);
export type GhRunnerLabel = typeof GhRunnerLabel.Type;

export const GhDeliveryId = Schema.NonEmptyString.pipe(
	Schema.brand("GhDeliveryId"),
);
export type GhDeliveryId = typeof GhDeliveryId.Type;

export const GhAdvertKeyId = Schema.NonEmptyString.pipe(
	Schema.brand("GhAdvertKeyId"),
);
export type GhAdvertKeyId = typeof GhAdvertKeyId.Type;

export const GhActorId = Schema.NonEmptyString.pipe(Schema.brand("GhActorId"));
export type GhActorId = typeof GhActorId.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

export const NonNegativeCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeCount"));
export type NonNegativeCount = typeof NonNegativeCount.Type;

export const PositiveRunId = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveRunId"));
export type PositiveRunId = typeof PositiveRunId.Type;

export const PositiveSlots = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(32),
).pipe(Schema.brand("PositiveSlots"));
export type PositiveSlots = typeof PositiveSlots.Type;

export const NonNegativeMinutes = Schema.Finite.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeMinutes"));
export type NonNegativeMinutes = typeof NonNegativeMinutes.Type;

export const NonNegativeCents = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeCents"));
export type NonNegativeCents = typeof NonNegativeCents.Type;

export const PercentLimit = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(100),
).pipe(Schema.brand("PercentLimit"));
export type PercentLimit = typeof PercentLimit.Type;

export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
	Schema.brand("EpochMs"),
);
export type EpochMs = typeof EpochMs.Type;

export const GH_HOSTED_PROVIDERS = [
	"blacksmith",
	"depot",
	"namespace",
	"warpbuild",
	"ubicloud",
	"boat",
	"runs-on",
] as const;

export const GhHostedProviderKey = Schema.Literals(GH_HOSTED_PROVIDERS);
export type GhHostedProviderKey = typeof GhHostedProviderKey.Type;

export const GH_STEP_KEYS = [
	"fleet",
	"machine",
	"github",
	...GH_HOSTED_PROVIDERS,
] as const;

export const GhStepKey = Schema.Literals(GH_STEP_KEYS);
export type GhStepKey = typeof GhStepKey.Type;

export const GH_AUTO_SIZES = [2, 4, 8, 16, 32] as const;
export const GhAutoSize = Schema.Literals(GH_AUTO_SIZES);
export type GhAutoSize = typeof GhAutoSize.Type;

export const GhMachineSharing = Schema.Literals(["only_me", "anyone"]);
export type GhMachineSharing = typeof GhMachineSharing.Type;

export const GhRetryTarget = Schema.Literals(["same", "other", "any"]);
export type GhRetryTarget = typeof GhRetryTarget.Type;

export const GhCheckName = Schema.Literals(["pr-title", "lint"]);
export type GhCheckName = typeof GhCheckName.Type;

export const GH_LINT_TOOLS = [
	"actionlint",
	"shellcheck",
	"oxlint",
	"oxfmt",
	"ruff",
	"zizmor",
	"typos",
] as const;
export const GhLintTool = Schema.Literals(GH_LINT_TOOLS);
export type GhLintTool = typeof GhLintTool.Type;

export const GhSkipReason = Schema.Literals([
	"not_configured",
	"public_repository",
	"fork_pull_request",
	"needs_isolation",
	"no_size",
	"too_many_labels",
	"not_provider_label",
	"minutes_limit",
	"minutes_runway",
	"spend_limit",
	"provider_unhealthy",
	"fleet_off",
	"fleet_full",
	"no_machine",
	"machine_paused",
	"machine_not_shared",
	"machine_full",
]);
export type GhSkipReason = typeof GhSkipReason.Type;

export const GhRelayJobStatusTag = Schema.Literals([
	"Unobserved",
	"Queued",
	"Claimed",
	"Routed",
	"Waiting",
	"CheckPassed",
	"CheckFailed",
	"RouteFailed",
	"Expired",
]);
export type GhRelayJobStatusTag = typeof GhRelayJobStatusTag.Type;

export const GhRouteStepConfig = Schema.Struct({
	key: GhStepKey,
	minutesLimitPercent: Schema.NullOr(PercentLimit),
	spendLimitCents: Schema.NullOr(NonNegativeCents),
});
export type GhRouteStepConfig = typeof GhRouteStepConfig.Type;

export const GhRetryPolicyConfig = Schema.Struct({
	enabled: Schema.Boolean,
	target: GhRetryTarget,
	maxRetries: Schema.Literals([1, 2]),
});
export type GhRetryPolicyConfig = typeof GhRetryPolicyConfig.Type;

export const GhRunnerOrderConfig = Schema.Struct({
	steps: Schema.Array(GhRouteStepConfig).check(Schema.isMinLength(1)),
	skipUnhealthy: Schema.Boolean,
	autoSizeVcpus: GhAutoSize,
	retry: Schema.NullOr(GhRetryPolicyConfig),
});
export type GhRunnerOrderConfig = typeof GhRunnerOrderConfig.Type;

export const GhStepCandidate = Schema.Struct({
	step: GhStepKey,
	labels: Schema.Array(GhRunnerLabel).check(Schema.isMinLength(1)),
});
export type GhStepCandidate = typeof GhStepCandidate.Type;

export const GhRouteSkip = Schema.Struct({
	step: GhStepKey,
	reason: GhSkipReason,
	detail: Schema.String,
});
export type GhRouteSkip = typeof GhRouteSkip.Type;

export const GhCheckStepSpec = Schema.Struct({
	check: GhCheckName,
	types: Schema.Array(Schema.NonEmptyString),
	tools: Schema.Array(GhLintTool),
	paths: Schema.Array(Schema.NonEmptyString),
});
export type GhCheckStepSpec = typeof GhCheckStepSpec.Type;

export const GhJobContext = Schema.Struct({
	accountId: GhAccountId,
	repository: GhRepoSlug,
	runId: PositiveRunId,
	runAttempt: PositiveRunId,
	jobName: Schema.NonEmptyString,
	matrixLeg: Schema.NullOr(Schema.NonEmptyString),
	isPrivate: Schema.Boolean,
	isFork: Schema.Boolean,
	actorId: GhActorId,
	runsOn: Schema.Array(GhRunnerLabel).check(Schema.isMinLength(1)),
	candidates: Schema.Array(GhStepCandidate),
	first: Schema.NullOr(GhStepKey),
	size: Schema.NullOr(GhAutoSize),
	checkSteps: Schema.Array(GhCheckStepSpec),
	hasNonCheckSteps: Schema.Boolean,
	pullRequestTitle: Schema.NullOr(Schema.String),
	nowMs: EpochMs,
});
export type GhJobContext = typeof GhJobContext.Type;

export const GhMachineSnapshot = Schema.Struct({
	machineId: GhMachineId,
	name: Schema.NonEmptyString,
	runsOnLabel: GhRunnerLabel,
	labels: Schema.Array(GhRunnerLabel),
	slots: PositiveSlots,
	busy: NonNegativeCount,
	paused: Schema.Boolean,
	online: Schema.Boolean,
	sharing: GhMachineSharing,
	ownerId: GhActorId,
	ownerCanRead: Schema.Boolean,
	isolatedContainer: Schema.Boolean,
	adopted: Schema.Boolean,
});
export type GhMachineSnapshot = typeof GhMachineSnapshot.Type;

export const GhFleetSnapshot = Schema.Struct({
	enabled: Schema.Boolean,
	taking: Schema.Boolean,
	isolated: Schema.Boolean,
});
export type GhFleetSnapshot = typeof GhFleetSnapshot.Type;
