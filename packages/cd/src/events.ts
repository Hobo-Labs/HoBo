// public-contract: event names, stream ids and schema ids are wire contract
// frozen by docs/plans/0024-hobo-cd-swarm-instruction.md (final).

// public-contract: every event family @hobo/cd appends.
export const CD_EVENTS = Object.freeze({
	FreightRecorded: "freight.Recorded",
	FreightYanked: "freight.Yanked",
	FreightQualified: "freight.Qualified",
	FreightApproved: "freight.Approved",
	FreightRetired: "freight.Retired",
	SourceDefined: "source.Defined",
	SourceArtifactDiscovered: "source.ArtifactDiscovered",
	PublisherTrusted: "publisher.Trusted",
	ArtifactStored: "artifact.Stored",
	ArtifactDeleted: "artifact.Deleted",
	SetCreated: "set.Created",
	DeltaOpened: "delta.Opened",
	DeltaUpdated: "delta.Updated",
	DeltaApplied: "delta.Applied",
	DeltaRejected: "delta.Rejected",
	PipelineApplied: "pipeline.Applied",
	PipelineFreightAvailable: "pipeline.FreightAvailable",
	WindowDefined: "window.Defined",
	WindowOverridden: "window.Overridden",
	EnvPromoteRequested: "env.PromoteRequested",
	EnvPromoted: "env.Promoted",
	EnvPromoteRolledBack: "env.PromoteRolledBack",
	EnvPromoteRejected: "env.PromoteRejected",
	EnvPromoteSuperseded: "env.PromoteSuperseded",
	EnvCloned: "env.Cloned",
	EnvExpired: "env.Expired",
	VerificationStarted: "verification.Started",
	VerificationCompleted: "verification.Completed",
	RolloutLowered: "rollout.Lowered",
	RolloutEvidenceObserved: "rollout.EvidenceObserved",
	ReconcilerEnrolled: "reconciler.Enrolled",
	ReconcilerRevoked: "reconciler.Revoked",
	ReconcileStarted: "deployment.ReconcileStarted",
	StatusObserved: "deployment.StatusObserved",
	Converged: "deployment.Converged",
	ReconcileBlocked: "deployment.ReconcileBlocked",
	CampStatusChanged: "camp.StatusChanged",
	CampTainted: "camp.Tainted",
	CampUntainted: "camp.Untainted",
	CampManagementChanged: "camp.ManagementChanged",
	CampDeparted: "camp.Departed",
	CampSetDefined: "campset.Defined",
	PlacementDefined: "placement.Defined",
	PlacementScoresReported: "placement.ScoresReported",
	PlacementDecided: "placement.Decided",
	FanoutStarted: "fanout.Started",
	FanoutProgressed: "fanout.Progressed",
	FanoutHalted: "fanout.Halted",
	FanoutResumed: "fanout.Resumed",
	FanoutCompleted: "fanout.Completed",
	FanoutRolledBack: "fanout.RolledBack",
	FailoverProposed: "failover.Proposed",
	FailoverStarted: "failover.Started",
	FailoverProgressed: "failover.Progressed",
	FailoverCompleted: "failover.Completed",
	FailoverRefused: "failover.Refused",
	RebalanceRequested: "rebalance.Requested",
	ReconcilerEnrollmentRequested: "reconciler.EnrollmentRequested",
	ReconcilerKeyApproved: "reconciler.KeyApproved",
	ReconcilerAccepted: "reconciler.Accepted",
	PolicyBindingChanged: "policy.BindingChanged",
	PolicyShadowDecided: "policy.ShadowDecided",
	ComplianceObserved: "compliance.Observed",
	ComplianceChanged: "compliance.Changed",
	PostureRemediationProposed: "posture.RemediationProposed",
} as const);

export type CdEventType = (typeof CD_EVENTS)[keyof typeof CD_EVENTS];

// public-contract: stream ids. Desired state (spec) and observations (status)
// live in separate per-Camp streams so they never contend.
export const CD_STREAMS = Object.freeze({
	freight: (freightId: string) => `cd-freight-${freightId}`,
	source: (name: string) => `cd-source-${name}`,
	artifact: (digest: string) => `cd-artifact-${digest}`,
	campSpec: (campId: string) => `cd-camp-${campId}`,
	campStatus: (campId: string) => `cd-camp-status-${campId}`,
	promotion: (promotionId: string) => `cd-promotion-${promotionId}`,
	pipeline: (name: string) => `cd-pipeline-${name}`,
	window: (name: string) => `cd-window-${name}`,
	verification: (verificationId: string) => `cd-verification-${verificationId}`,
	reconciler: (reconcilerId: string) => `cd-reconciler-${reconcilerId}`,
	publisher: (name: string) => `cd-publisher-${name}`,
	campInventory: (campId: string) => `cd-camp-inventory-${campId}`,
	campSet: (name: string) => `cd-campset-${name}`,
	placement: (name: string) => `cd-placement-${name}`,
	fanout: (fanoutId: string) => `cd-fanout-${fanoutId}`,
	failover: (failoverId: string) => `cd-failover-${failoverId}`,
	compliance: (campId: string) => `cd-compliance-${campId}`,
});

// public-contract: durable subscription ids. Leases are keyed by Camp so two
// reconcilers can never both write one Camp.
export const CD_SUBSCRIPTIONS = Object.freeze({
	camp: (campId: string) => `cd:camp:${campId}`,
	source: (name: string) => `cd:source:${name}`,
	fanout: (fanoutId: string) => `cd:fanout:${fanoutId}`,
	failover: (failoverId: string) => `cd:failover:${failoverId}`,
	posture: (stationId: string) => `cd:posture:${stationId}`,
	inventory: (stationId: string) => `cd:inventory:${stationId}`,
});

// public-contract: schema ids.
export const FREIGHT_MANIFEST_SCHEMA = "hobo.freight-manifest/v1" as const;
// public-contract: schema ids.
export const FREIGHT_SCHEMA = "hobo.cd.freight/v1" as const;
// public-contract: schema ids.
export const SOURCE_SCHEMA = "hobo.cd.source/v1" as const;
// public-contract: schema ids.
export const SET_SCHEMA = "hobo.cd.set/v1" as const;
// public-contract: schema ids.
export const DELTA_SCHEMA = "hobo.cd.delta/v1" as const;
// public-contract: schema ids.
export const PROMOTION_SCHEMA = "hobo.cd.promotion/v1" as const;
// public-contract: schema ids.
export const PIPELINE_SCHEMA = "hobo.cd.pipeline/v1" as const;
// public-contract: schema ids.
export const PLACEMENT_SCHEMA = "hobo.cd.placement/v1" as const;
// public-contract: media type of a stored resolved-set blob.
export const RESOLVED_SET_MEDIA_TYPE = "application/vnd.hobo.resolved-set+json" as const;
// public-contract: inline limit for resolved sets on the delivery feed.
export const FEED_INLINE_LIMIT_BYTES = 262_144 as const;
// public-contract: refusal codes.
export const PROGRESSIVE_UNSUPPORTED = "progressive-unsupported" as const;
// public-contract: refusal codes.
export const LINEAGE_UNSATISFIED = "lineage-unsatisfied" as const;
// public-contract: refusal codes.
export const WINDOW_CLOSED = "window-closed" as const;
// public-contract: refusal codes.
export const UNVERIFIED_TRIGGER = "unverified-trigger" as const;
// public-contract: refusal codes.
export const PLACEMENT_UNSATISFIABLE = "placement-unsatisfiable" as const;
// public-contract: refusal codes.
export const FAILOVER_UNSAFE = "failover-unsafe" as const;
// public-contract: refusal codes.
export const OWNERSHIP_CONFLICT = "ownership-conflict" as const;
// public-contract: refusal codes.
export const ENROLLMENT_INCOMPLETE = "enrollment-incomplete" as const;
// public-contract: refusal codes.
export const FANOUT_BUDGET_EXCEEDED = "fanout-budget-exceeded" as const;
// public-contract: refusal codes.
export const SHADOW_REQUIRED = "shadow-required" as const;
// public-contract: per-resource bound on reported posture attributes.
export const OBSERVE_ATTRIBUTES_LIMIT_BYTES = 16_384 as const;

// public-contract: every default value (Part I §I.9). Durations are milliseconds.
export const CD_DEFAULTS = Object.freeze({
	leaseTtlMs: 30_000,
	leaseRenewMs: 10_000,
	unreachableAfterMs: 90_000,
	feedHeartbeatMs: 15_000,
	feedLongPollMs: 55_000,
	svidTtlMs: 900_000,
	svidRefreshBeforeExpiryMs: 300_000,
	credentialWarningMs: 120_000,
	dpopSkewMs: 60_000,
	bootstrapTokenTtlMs: 3_600_000,
	bootstrapTokenMaxTtlMs: 86_400_000,
	sourcePollIntervalMs: 300_000,
	sourcePollIntervalMinMs: 30_000,
	sourceBackoffBaseMs: 1_000,
	sourceBackoffMaxMs: 600_000,
	sourceDiscoveryLimit: 20,
	serviceTickMs: 1_000,
	verificationWindowMs: 600_000,
	verificationRequiredObservations: 3,
	verificationProgressDeadlineMs: 1_800_000,
	verificationSensitivity: "MEDIUM",
	verificationFailOnNoData: true,
	probeTimeoutMs: 5_000,
	approvalTtlMs: 86_400_000,
	hotfixApprovalMaxMs: 259_200_000,
	windowOverrideMaxMs: 14_400_000,
	retentionKeepPerCamp: 5,
	retentionKeepUnpromotedMs: 2_592_000_000,
	retentionBlobGraceMs: 604_800_000,
	listNodeAvailability: "ONE_OF",
	placedNodeAvailability: "QUORUM",
	fanoutStrategy: "PROGRESSIVE_PER_GROUP",
	fanoutGroupSizePercent: 10,
	fanoutMinSuccessMs: 300_000,
	fanoutProgressDeadlineMs: 1_800_000,
	fanoutMaxFailuresPercent: 5,
	fanoutRollbackOnHalt: true,
	fanoutQuorumPercent: 95,
	noRunTolerationMs: 300_000,
	scoreMaxValidityMs: 86_400_000,
	maxFanoutCamps: 1_000,
	taintRequiredSignals: 2,
	failoverAutomatic: false,
	failoverMaxConcurrent: 1,
	failoverPurge: "GRACEFUL",
	failoverGraceMs: 1_800_000,
	departureAction: "ORPHAN_DATA",
	enrollmentSeparateApprovers: true,
	postureCompliantIntervalMs: 3_600_000,
	postureNoncompliantIntervalMs: 300_000,
	postureRemediation: "inform",
	informWindowMs: 86_400_000,
	informMaxNoncompliantRatio: 0.02,
	informMaxShadowDivergence: 0,
	componentMemoryBytes: 134_217_728,
	componentCallTimeoutMs: 30_000,
	componentFuel: 1_000_000_000,
	componentMaxAllowlistHosts: 32,
	webhookMaxAttempts: 8,
	webhookBackoffBaseMs: 1_000,
	webhookBackoffMaxMs: 300_000,
	postgresMinMajorVersion: 16,
	postgresStatementTimeoutMs: 5_000,
	postgresPoolSize: 10,
} as const);

// public-contract: the one set of ramp defaults (replaces three vocabularies).
export const CD_RAMP_DEFAULTS = Object.freeze({
	canary: Object.freeze([5, 25, 50, 100] as const),
	blueGreen: Object.freeze([100] as const),
	experiment: Object.freeze([50] as const),
} as const);
