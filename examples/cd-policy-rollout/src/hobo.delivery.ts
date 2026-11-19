import { create } from "@bufbuild/protobuf";
import {
	Aggregation,
	AutoPromotion,
	Availability,
	CD_DEFAULTS,
	ChangeWindowRecordSchema,
	Comparator,
	FreightSourceRecordSchema,
	FreightSubject,
	HealthQueryRecordSchema,
	HealthSourceKind,
	PIPELINE_SCHEMA,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	PolicyMode,
	RailDeliveryRecordSchema,
	RailPostureBindingRecordSchema,
	RemediationMode,
	RolloutStrategy,
	SOURCE_SCHEMA,
	SubscriptionKind,
	SubscriptionRecordSchema,
	ThresholdCheckRecordSchema,
	VerificationSpecRecordSchema,
	WindowKind,
} from "@hobo/cd";

export const RAIL = "rail-eu-storage";

export const EXPECTED_DIVERGENCES = 1;

export const source = create(FreightSourceRecordSchema, {
	schemaVersion: SOURCE_SCHEMA,
	name: "rail-eu-storage",
	bindle: RAIL,
	automatic: true,
	pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
	subscriptions: [create(SubscriptionRecordSchema, { name: "approved", kind: SubscriptionKind.HOBO_RAIL, locator: "station:eu-central" })],
});

const posture = (name: string, query: string) =>
	create(HealthQueryRecordSchema, { name, source: HealthSourceKind.HOBO_POSTURE, endpointRef: "hobo://posture", query, unit: "ratio" });

export const informVerification = create(VerificationSpecRecordSchema, {
	windowMs: BigInt(CD_DEFAULTS.informWindowMs),
	requiredObservations: CD_DEFAULTS.verificationRequiredObservations,
	progressDeadlineMs: BigInt(CD_DEFAULTS.informWindowMs + CD_DEFAULTS.verificationProgressDeadlineMs),
	failOnNoData: true,
	thresholds: [
		create(ThresholdCheckRecordSchema, { query: posture("noncompliant_ratio", "noncompliant_ratio"), aggregation: Aggregation.MAX, comparator: Comparator.LTE, value: CD_DEFAULTS.informMaxNoncompliantRatio }),
		create(ThresholdCheckRecordSchema, { query: posture("shadow_divergence", "shadow_divergence"), aggregation: Aggregation.SUM, comparator: Comparator.LTE, value: EXPECTED_DIVERGENCES }),
	],
});

export const changeFreeze = create(ChangeWindowRecordSchema, {
	name: "eu-business-hours-only",
	kind: WindowKind.ALLOW,
	rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;BYHOUR=9",
	durationMs: 8n * 3_600_000n,
	timezone: "Europe/Berlin",
	startsAt: "2026-01-05T09:00:00+01:00",
	rollbackAllowed: true,
});

export const pipeline = create(PipelineRecordSchema, {
	schemaVersion: PIPELINE_SCHEMA,
	name: "rail-eu-storage",
	bindle: RAIL,
	subject: FreightSubject.RAIL,
	nodes: [
		create(PipelineNodeRecordSchema, {
			name: "shadow",
			placement: "eu-storage-camps",
			fromSources: ["rail-eu-storage"],
			availability: Availability.QUORUM,
			autoPromotion: AutoPromotion.NEWEST,
			strategy: RolloutStrategy.ALL_AT_ONCE,
			policyMode: PolicyMode.INFORM,
			verification: informVerification,
		}),
		create(PipelineNodeRecordSchema, {
			name: "enforce",
			placement: "eu-storage-camps",
			fromNodes: ["shadow"],
			availability: Availability.QUORUM,
			autoPromotion: AutoPromotion.DISABLED,
			approvalRequired: true,
			strategy: RolloutStrategy.ALL_AT_ONCE,
			policyMode: PolicyMode.ENFORCE,
			windows: ["eu-business-hours-only"],
		}),
	],
});

export const railDelivery = create(RailDeliveryRecordSchema, {
	campSets: ["eu-storage"],
	posture: [
		create(RailPostureBindingRecordSchema, {
			pack: "storage-baseline",
			remediation: RemediationMode.INFORM,
			compliantIntervalMs: BigInt(CD_DEFAULTS.postureCompliantIntervalMs),
			noncompliantIntervalMs: BigInt(CD_DEFAULTS.postureNoncompliantIntervalMs),
		}),
		create(RailPostureBindingRecordSchema, { pack: "eu-residency", remediation: RemediationMode.INFORM_ONLY }),
	],
	maxFanoutCamps: CD_DEFAULTS.maxFanoutCamps,
});

export const delivery = { sources: [source], publishers: [], windows: [changeFreeze], pipelines: [pipeline] };
