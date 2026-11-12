// Deliver a Rail like software (plan 0024 D24, D25, I22, I23, R12).
//
// A Rail version is Freight with subject RAIL, discovered when the Rail is
// approved (HOBO_RAIL). Its pipeline binds it first as a candidate in INFORM.
// While it is a candidate, the enforced Rail still decides; the gate shadows
// the candidate and posture evaluates it. The INFORM node qualifies on
// HOBO_POSTURE series: noncompliant ratio and shadow divergence over 24 h.
// Only then can the ENFORCE node bind it as the enforced Rail. Rollback
// restores the previous digest through the gate, and windows always allow it.
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

/** The new Rail blocks public buckets, and its authors expect it to change exactly one decision during the shadow period. */
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

/** R12: pass only with ≤ 2 % noncompliant and no more than the declared divergences over 24 h. */
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

/** Station Rail `delivery`: posture packs bound in `inform`; enforcement acts only through repair Deltas. */
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
