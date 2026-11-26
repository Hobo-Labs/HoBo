// Golden upcaster corpus for the event bodies the posture module appends:
// policy.BindingChanged (PolicyBindingRecord), policy.ShadowDecided
// (ShadowDecisionRecord), compliance.Observed and compliance.Changed
// (ComplianceRecord) and posture.RemediationProposed
// (PostureRemediationRecord). Append-only: a body change needs a new
// version, a total upcaster and a new pinned entry (ADR-0032). Field tags
// follow cd.proto.
//
// The corpus codec has scalar, string-list and JSON-object fields only, so
// `toPostureCorpusBody` carries repeated messages (`findings`, `reasons`) as
// their members' canonical JSON: a lossless, deterministic view.
import {
	boolField,
	type CorpusBaseline,
	createCorpusBaseline,
	createCorpusEntry,
	type EventBody,
	type EventEvolutionContract,
	type EventFieldSpec,
	eventSchema,
	stringField,
	stringsField,
} from "@hobo/events";
import { CD_EVENTS } from "../events.js";
import {
	canonicalJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	jsonOf,
} from "./journal.js";

const OPTIONAL = { required: false } as const;

const BINDING_FIELDS: readonly EventFieldSpec[] = [
	stringField("campId", 1),
	stringField("enforcedRailDigest", 2, OPTIONAL),
	stringField("candidateRailDigest", 3, OPTIONAL),
	stringField("freightId", 4, OPTIONAL),
	stringField("promotionId", 5),
	stringField("boundAt", 6),
];

const SHADOW_FIELDS: readonly EventFieldSpec[] = [
	stringField("campId", 1),
	stringField("deltaId", 2),
	stringField("enforcedRailDigest", 3, OPTIONAL),
	stringField("candidateRailDigest", 4),
	stringField("enforcedEffect", 5),
	stringField("candidateEffect", 6),
	// bool diverged = 7 is omitted from protobuf JSON when false.
	boolField("diverged", 7, OPTIONAL),
	stringField("decidedAt", 8),
];

const COMPLIANCE_FIELDS: readonly EventFieldSpec[] = [
	stringField("campId", 1),
	stringField("railDigest", 2),
	boolField("candidate", 3, OPTIONAL),
	stringField("state", 4),
	stringsField("findings", 5, OPTIONAL),
	stringField("observationPosition", 6),
	stringField("evaluatedAt", 7),
];

const REMEDIATION_FIELDS: readonly EventFieldSpec[] = [
	stringField("campId", 1),
	stringField("rule", 2),
	stringField("resource", 3),
	stringField("mode", 4),
	stringField("deltaId", 5, OPTIONAL),
	stringsField("reasons", 6),
];

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const AT = "2026-11-12T12:00:00.000Z";

const FINDING_NONCOMPLIANT = canonicalJson({
	rule: "tls-baseline/tls-min-version",
	resource: "api",
	state: "COMPLIANCE_STATE_NONCOMPLIANT",
	severity: "high",
	controls: ["SC-8"],
	observed: "tls.min_version=1.0",
	ownershipConflict: true,
});
const FINDING_NA = canonicalJson({
	rule: "tls-baseline/no-public-buckets",
	state: "COMPLIANCE_STATE_NOT_APPLICABLE",
	severity: "critical",
	controls: ["AC-3"],
});
const COMPLIANCE: EventBody = {
	campId: "prod-1",
	railDigest: A,
	state: "COMPLIANCE_STATE_NONCOMPLIANT",
	findings: [FINDING_NA, FINDING_NONCOMPLIANT],
	observationPosition: "42",
	evaluatedAt: AT,
};

function v1(
	type: string,
	fields: readonly EventFieldSpec[],
	bodies: readonly EventBody[],
): EventEvolutionContract {
	const schema = eventSchema(type, 1, fields);
	const slug = type.replaceAll(".", "-");
	return Object.freeze({
		type,
		currentVersion: 1,
		schemas: Object.freeze([schema]),
		upcasters: Object.freeze([]),
		goldenCorpus: Object.freeze(
			bodies.map((body, index) =>
				createCorpusEntry(
					schema,
					`${slug}-v1${index === 0 ? "" : `-${index}`}`,
					body,
				),
			),
		),
	});
}

// public-contract: evolution contracts for the policy/posture events WP24 appends (golden corpus).
export const POSTURE_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		v1(CD_EVENTS.PolicyBindingChanged, BINDING_FIELDS, [
			{
				campId: "prod-1",
				candidateRailDigest: B,
				freightId: `sha256:${"1".repeat(64)}`,
				promotionId: "promo_1",
				boundAt: AT,
			},
			{
				campId: "prod-1",
				enforcedRailDigest: B,
				freightId: `sha256:${"1".repeat(64)}`,
				promotionId: "promo_2",
				boundAt: AT,
			},
			{ campId: "prod-1", promotionId: "promo_2", boundAt: AT },
		]),
		v1(CD_EVENTS.PolicyShadowDecided, SHADOW_FIELDS, [
			{
				campId: "prod-1",
				deltaId: "delta_1",
				enforcedRailDigest: A,
				candidateRailDigest: B,
				enforcedEffect: "allow",
				candidateEffect: "deny",
				diverged: true,
				decidedAt: AT,
			},
			{
				campId: "prod-1",
				deltaId: "delta_2",
				candidateRailDigest: B,
				enforcedEffect: "allow",
				candidateEffect: "allow",
				decidedAt: AT,
			},
		]),
		v1(CD_EVENTS.ComplianceObserved, COMPLIANCE_FIELDS, [
			COMPLIANCE,
			{
				campId: "prod-1",
				railDigest: B,
				candidate: true,
				state: "COMPLIANCE_STATE_UNKNOWN",
				observationPosition: "43",
				evaluatedAt: AT,
			},
		]),
		v1(CD_EVENTS.ComplianceChanged, COMPLIANCE_FIELDS, [COMPLIANCE]),
		v1(CD_EVENTS.PostureRemediationProposed, REMEDIATION_FIELDS, [
			{
				campId: "prod-1",
				rule: "tls-baseline/tls-min-version",
				resource: "api",
				mode: "REMEDIATION_MODE_ENFORCE",
				deltaId: `delta_posture_${"0".repeat(24)}`,
				reasons: [
					canonicalJson({
						code: "posture-remediation-proposed",
						message: "proposed",
						remediation: "gate decides",
						subject: "api",
					}),
					canonicalJson({
						code: "posture-fix",
						message: '[{"field":"tls.min_version","value":"1.3"}]',
						remediation: "reconciler applies",
						subject: "api",
					}),
				],
			},
			{
				campId: "prod-1",
				rule: "tls-baseline/tls-min-version",
				resource: "api",
				mode: "REMEDIATION_MODE_ENFORCE",
				reasons: [
					canonicalJson({
						code: "ownership-conflict",
						message: "conflict",
						remediation: "change the declaration",
						subject: "api",
					}),
				],
			},
		]),
	]);

export function postureCorpusBaseline(): CorpusBaseline {
	return createCorpusBaseline(
		POSTURE_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}

const REPEATED_MESSAGES: ReadonlySet<string> = new Set(["findings", "reasons"]);

/** The corpus view of a journal body: repeated messages become canonical JSON strings. */
export function toPostureCorpusBody<T>(data: T): EventBody {
	const document = jsonOf(data);
	if (!isJsonObject(document)) return {};
	const out: Record<string, EventBody[string]> = {};
	for (const [key, value] of Object.entries(document)) {
		if (REPEATED_MESSAGES.has(key) && Array.isArray(value))
			out[key] = value.map((item) => canonicalJson(item));
		else if (isJsonString(value) || isJsonNumber(value) || isJsonBoolean(value))
			out[key] = value;
		else if (Array.isArray(value) && value.every((item) => isJsonString(item)))
			out[key] = value.map(String);
		else if (value !== null) out[key] = canonicalJson(value);
	}
	return out;
}
