import { create } from "@bufbuild/protobuf";
import {
	AutoPromotion,
	Availability,
	CampSetRecordSchema,
	CD_DEFAULTS,
	CD_RAMP_DEFAULTS,
	DepartureAction,
	FailoverPolicyRecordSchema,
	FanoutRecordSchema,
	FanoutStrategy,
	FreightSourceRecordSchema,
	FreightSubject,
	PIPELINE_SCHEMA,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	PLACEMENT_SCHEMA,
	PlacementGroupRecordSchema,
	PlacementRecordSchema,
	PurgeMode,
	QuorumRecordSchema,
	RailDeliveryRecordSchema,
	RailFailoverRecordSchema,
	RolloutStrategy,
	SelectionStrategy,
	SelectorRecordSchema,
	SOURCE_SCHEMA,
	SpreadConstraintRecordSchema,
	SubscriptionKind,
	SubscriptionRecordSchema,
	TaintEffect,
	TolerationRecordSchema,
	VerificationSpecRecordSchema,
} from "@hobo/cd";

export const BINDLE = "retail/pos";

export const source = create(FreightSourceRecordSchema, {
	schemaVersion: SOURCE_SCHEMA,
	name: "pos",
	bindle: BINDLE,
	automatic: true,
	pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
	subscriptions: [
		create(SubscriptionRecordSchema, {
			name: "pos-app",
			kind: SubscriptionKind.PACKAGE_REGISTRY,
			locator: "pkg:npm/%40retail/pos-edge",
			ecosystem: "npm",
			selection: SelectionStrategy.SEMVER,
			semverRange: ">=2.0.0",
			discoveryLimit: CD_DEFAULTS.sourceDiscoveryLimit,
			credentialRef: "vault://retail/npm-read",
		}),
	],
});

export const stores = create(CampSetRecordSchema, {
	name: "retail-stores",
	selector: create(SelectorRecordSchema, { labels: { fleet: "retail" }, envTypes: ["prod"] }),
});

export const placement = create(PlacementRecordSchema, {
	schemaVersion: PLACEMENT_SCHEMA,
	name: "all-stores",
	campSets: ["retail-stores"],
	predicate: create(SelectorRecordSchema, { envTypes: ["prod"] }),
	count: 0,
	spread: [create(SpreadConstraintRecordSchema, { topologyKey: "region", minGroups: 4 })],
	groups: [create(PlacementGroupRecordSchema, { name: "pilot", selector: create(SelectorRecordSchema, { labels: { tier: "pilot" } }), maxSize: 8 })],
	defaultGroupSizePercent: CD_DEFAULTS.fanoutGroupSizePercent,
	tolerations: [create(TolerationRecordSchema, { key: "hobo.cd/maintenance", effect: TaintEffect.NO_RUN, tolerationMs: BigInt(CD_DEFAULTS.noRunTolerationMs) })],
});

export const fanout = create(FanoutRecordSchema, {
	strategy: FanoutStrategy.PROGRESSIVE_PER_GROUP,
	maxConcurrencyPercent: CD_DEFAULTS.fanoutGroupSizePercent,
	minSuccessMs: BigInt(CD_DEFAULTS.fanoutMinSuccessMs),
	progressDeadlineMs: BigInt(CD_DEFAULTS.fanoutProgressDeadlineMs),
	maxFailuresPercent: CD_DEFAULTS.fanoutMaxFailuresPercent,
	mandatoryGroups: ["pilot"],
	rollbackOnHalt: CD_DEFAULTS.fanoutRollbackOnHalt,
});

export const railDelivery = create(RailDeliveryRecordSchema, {
	campSets: ["retail-stores"],
	failover: create(RailFailoverRecordSchema, {
		automatic: true,
		maxConcurrent: CD_DEFAULTS.failoverMaxConcurrent,
		allowImmediatePurge: false,
		requiredSignals: CD_DEFAULTS.taintRequiredSignals,
	}),
	maxFanoutCamps: CD_DEFAULTS.maxFanoutCamps,
});

export const pipeline = create(PipelineRecordSchema, {
	schemaVersion: PIPELINE_SCHEMA,
	name: "pos",
	bindle: BINDLE,
	subject: FreightSubject.BINDLE,
	nodes: [
		create(PipelineNodeRecordSchema, {
			name: "lab",
			campIds: ["store-lab"],
			fromSources: ["pos"],
			availability: Availability.ONE_OF,
			autoPromotion: AutoPromotion.NEWEST,
			strategy: RolloutStrategy.CANARY,
			stagePercents: [...CD_RAMP_DEFAULTS.canary],
			verification: create(VerificationSpecRecordSchema, {
				windowMs: BigInt(CD_DEFAULTS.verificationWindowMs),
				requiredObservations: CD_DEFAULTS.verificationRequiredObservations,
				progressDeadlineMs: BigInt(CD_DEFAULTS.verificationProgressDeadlineMs),
				failOnNoData: true,
			}),
		}),
		create(PipelineNodeRecordSchema, {
			name: "stores",
			placement: "all-stores",
			fromNodes: ["lab"],
			availability: Availability.QUORUM,
			autoPromotion: AutoPromotion.MATCH_NODE,
			strategy: RolloutStrategy.ALL_AT_ONCE,
			fanout,
			quorum: create(QuorumRecordSchema, { minQualifiedPercent: CD_DEFAULTS.fanoutQuorumPercent }),
			departure: DepartureAction.ORPHAN_DATA,
			failover: create(FailoverPolicyRecordSchema, { purge: PurgeMode.GRACEFUL, graceMs: BigInt(CD_DEFAULTS.failoverGraceMs) }),
		}),
	],
});

export const delivery = { sources: [source], publishers: [], windows: [], pipelines: [pipeline] };
