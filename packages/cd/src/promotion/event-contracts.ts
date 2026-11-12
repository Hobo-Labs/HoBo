// Golden upcaster corpus for the event bodies the promotion saga appends:
// env.PromoteRequested / Promoted / PromoteRejected / PromoteSuperseded /
// PromoteRolledBack (PromotionRecord) and env.Cloned / Expired
// (PreviewEnvironmentRecord). Append-only: a body change needs a new
// version, a total upcaster and a new pinned entry (ADR-0032). Field tags
// follow cd.proto. The saga.* facts belong to @hobo/events' own corpus.
//
// The corpus codec has scalar, string-list and JSON-object fields only, so
// `toPromotionCorpusBody` carries repeated messages (`reasons`,
// `obligations`) as their members' canonical JSON and a nested message
// (`source`) as its canonical JSON: a lossless, deterministic view.
import {
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
	isJsonObject,
	isNumber,
	isText,
	toJsonValue,
} from "./journal.js";

const OPTIONAL = { required: false } as const;

const PROMOTION_FIELDS: readonly EventFieldSpec[] = [
	stringField("schemaVersion", 1),
	stringField("promotionId", 2),
	stringField("freightId", 3),
	stringField("sourceCampId", 4, OPTIONAL),
	stringsField("targetCampIds", 5),
	stringField("pipeline", 6, OPTIONAL),
	stringField("node", 7, OPTIONAL),
	stringField("state", 8),
	stringField("gateDecisionId", 9, OPTIONAL),
	stringsField("obligations", 10, OPTIONAL),
	stringField("requestedBy", 11),
	stringField("requestedAt", 12),
	stringsField("reasons", 13, OPTIONAL),
	stringField("strategy", 14, OPTIONAL),
	// bool proposal = 15 is omitted from protobuf JSON when false.
	{ name: "proposal", tag: 15, type: "bool", required: false },
	stringField("idempotencyKey", 16),
	stringField("fanoutId", 17, OPTIONAL),
	stringField("subject", 18),
];

const PREVIEW_FIELDS: readonly EventFieldSpec[] = [
	stringField("campId", 1),
	stringField("sourceCampId", 2),
	stringField("freightId", 3),
	// uint64 is a decimal string in protobuf JSON.
	stringField("ttlMs", 4),
	stringField("expiresAt", 5),
	stringField("createdBy", 6),
	stringField("source", 7, OPTIONAL),
	stringField("pipeline", 8, OPTIONAL),
	stringField("node", 9, OPTIONAL),
];

const FREIGHT = `sha256:${"1".repeat(64)}`;
const REQUESTED: EventBody = {
	schemaVersion: "hobo.cd.promotion/v1",
	promotionId: "promo_0123456789abcdef01234567",
	freightId: FREIGHT,
	sourceCampId: "staging-1",
	targetCampIds: ["prod-1", "prod-2"],
	pipeline: "shop",
	node: "prod",
	state: "PROMOTION_STATE_QUEUED",
	requestedBy: "user:ops@example.test",
	requestedAt: "2026-11-12T00:00:00.000Z",
	strategy: "ROLLOUT_STRATEGY_CANARY",
	idempotencyKey: "k1",
	subject: "FREIGHT_SUBJECT_BINDLE",
};
const PREVIEW: EventBody = {
	campId: "dev-1--pv-0123456789",
	sourceCampId: "dev-1",
	freightId: FREIGHT,
	ttlMs: "3600000",
	expiresAt: "2026-11-12T01:00:00.000Z",
	createdBy: "user:ops@example.test",
	source: canonicalJson({
		repository: "https://git.example/shop",
		commit: "abc123",
	}),
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

// public-contract: evolution contracts for the env.* promotion events (golden corpus).
export const PROMOTION_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		v1(CD_EVENTS.EnvPromoteRequested, PROMOTION_FIELDS, [
			REQUESTED,
			{
				schemaVersion: "hobo.cd.promotion/v1",
				promotionId: "promo_fedcba9876543210fedcba98",
				freightId: FREIGHT,
				targetCampIds: ["c-1"],
				state: "PROMOTION_STATE_QUEUED",
				requestedBy: "agent:fleet-bot",
				requestedAt: "2026-11-12T00:00:00.000Z",
				proposal: true,
				idempotencyKey: "fo-1:c-1",
				fanoutId: "fo-1",
				subject: "FREIGHT_SUBJECT_RAIL",
			},
		]),
		v1(CD_EVENTS.EnvPromoted, PROMOTION_FIELDS, [
			{
				...REQUESTED,
				targetCampIds: ["prod-1"],
				state: "PROMOTION_STATE_PROMOTED",
				gateDecisionId: "gate_0123456789abcdef01234567",
			},
		]),
		v1(CD_EVENTS.EnvPromoteRejected, PROMOTION_FIELDS, [
			{
				...REQUESTED,
				targetCampIds: ["prod-2"],
				state: "PROMOTION_STATE_FAILED",
				reasons: [
					canonicalJson({
						code: "promotion-verification-failed",
						message: "verification FAIL",
						remediation: "inspect checks",
						subject: "prod-2",
					}),
				],
			},
		]),
		v1(CD_EVENTS.EnvPromoteSuperseded, PROMOTION_FIELDS, [
			{
				...REQUESTED,
				targetCampIds: ["prod-1"],
				state: "PROMOTION_STATE_SUPERSEDED",
				reasons: [
					canonicalJson({
						code: "promotion-superseded",
						message: "superseded",
						remediation: "nothing to do",
						subject: "prod-1",
					}),
				],
			},
		]),
		v1(CD_EVENTS.EnvPromoteRolledBack, PROMOTION_FIELDS, [
			{
				schemaVersion: "hobo.cd.promotion/v1",
				promotionId: "rollback_0123456789abcdef01234567",
				freightId: FREIGHT,
				targetCampIds: ["prod-1"],
				state: "PROMOTION_STATE_ROLLED_BACK",
				gateDecisionId: "gate_0123456789abcdef01234567",
				requestedBy: "user:ops@example.test",
				requestedAt: "2026-11-12T00:00:00.000Z",
				reasons: [
					canonicalJson({
						code: "rollback",
						message: "error spike",
						remediation: "promote again",
						subject: "prod-1",
					}),
				],
				idempotencyKey: "rb1",
				subject: "FREIGHT_SUBJECT_BINDLE",
			},
		]),
		v1(CD_EVENTS.EnvCloned, PREVIEW_FIELDS, [PREVIEW]),
		v1(CD_EVENTS.EnvExpired, PREVIEW_FIELDS, [PREVIEW]),
	]);

export function promotionCorpusBaseline(): CorpusBaseline {
	return createCorpusBaseline(
		PROMOTION_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}

const REPEATED_MESSAGES: ReadonlySet<string> = new Set([
	"reasons",
	"obligations",
]);

/** The corpus view of a journal body: messages become canonical JSON strings. */
export function toPromotionCorpusBody<T>(data: T): EventBody {
	const document = toJsonValue(data);
	if (!isJsonObject(document)) return {};
	const body: Record<string, EventBody[string]> = {};
	for (const [key, value] of Object.entries(document)) {
		if (REPEATED_MESSAGES.has(key) && Array.isArray(value)) {
			body[key] = value.map((item) => canonicalJson(item));
		} else if (Array.isArray(value) && value.every((item) => isText(item))) {
			body[key] = value.map(String);
		} else if (
			isText(value) ||
			isNumber(value) ||
			value === true ||
			value === false
		) {
			body[key] = value;
		} else {
			body[key] = canonicalJson(value);
		}
	}
	return body;
}
