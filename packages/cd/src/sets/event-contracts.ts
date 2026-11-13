// Golden upcaster corpus for the event bodies this module appends: set.Created
// and delta.*. Append-only: a body change needs a new version, a total
// upcaster and a new pinned entry (ADR-0032). Field tags follow cd.proto.
//
// The journal body is the protobuf JSON of the generated record. The corpus
// codec (`protobuf-lite`) has scalar, string-list and JSON-object fields only,
// so `toCorpusBody` carries a repeated message (`changes`, `reasons`) as the
// list of its members' canonical JSON. That is a lossless, deterministic view
// of the same body; the contract test runs every appended body through it.
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
	isFlag,
	isJsonObject,
	isNumber,
	isText,
	toJsonValue,
} from "./json.js";

const OPTIONAL = { required: false } as const;

const SET_FIELDS: readonly EventFieldSpec[] = [
	stringField("schemaVersion", 1),
	stringField("setId", 2),
	stringField("tenant", 3),
	stringField("environment", 4, OPTIONAL),
	stringField("campId", 5),
	stringField("freightId", 6, OPTIONAL),
	stringField("planHash", 7),
	stringField("contentHash", 8),
	stringField("predecessorSetId", 9, OPTIONAL),
	stringField("gateDecisionId", 10),
	stringField("origin", 11),
	stringField("resolvedSetDigest", 12),
	// uint64 is a decimal string in protobuf JSON.
	stringField("resolvedSetBytes", 13),
	stringField("createdAt", 14),
];

const DELTA_FIELDS: readonly EventFieldSpec[] = [
	stringField("schemaVersion", 1),
	stringField("deltaId", 2),
	stringField("campId", 3),
	stringField("baseSetId", 4, OPTIONAL),
	stringField("freightId", 5, OPTIONAL),
	stringsField("changes", 6, OPTIONAL),
	stringsField("infrastructureDiff", 7, OPTIONAL),
	stringField("openedBy", 8, OPTIONAL),
	// bool proposal = 9 is omitted from protobuf JSON when false.
	{ name: "proposal", tag: 9, type: "bool", required: false },
	stringField("openedAt", 10, OPTIONAL),
	stringField("intent", 11),
];

const DECISION_FIELDS: readonly EventFieldSpec[] = [
	stringField("deltaId", 1),
	stringField("setId", 2, OPTIONAL),
	stringField("gateDecisionId", 3, OPTIONAL),
	stringsField("reasons", 4, OPTIONAL),
	stringField("decidedAt", 5, OPTIONAL),
];

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const FREIGHT = `sha256:${"1".repeat(64)}`;

const ADD_API = canonicalJson({
	resource: "shop.api",
	kind: "CHANGE_KIND_ADD",
	provider: "aws",
	afterHash: DIGEST_A,
});
const UPDATE_API = canonicalJson({
	resource: "shop.api",
	kind: "CHANGE_KIND_UPDATE",
	provider: "aws",
	beforeHash: DIGEST_A,
	afterHash: DIGEST_B,
});

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

// public-contract: evolution contracts for set.Created and delta.* (golden corpus).
export const SET_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		v1(CD_EVENTS.SetCreated, SET_FIELDS, [
			{
				schemaVersion: "hobo.cd.set/v1",
				setId: "set_0123456789abcdef0123456789abcdef",
				tenant: "acme",
				environment: "production",
				campId: "prod-aws",
				freightId: FREIGHT,
				planHash: DIGEST_A,
				contentHash: DIGEST_B,
				gateDecisionId: "gate-1",
				origin: "SET_ORIGIN_PROMOTION",
				resolvedSetDigest: DIGEST_C,
				resolvedSetBytes: "2048",
				createdAt: "2026-11-12T00:00:00.000Z",
			},
			{
				schemaVersion: "hobo.cd.set/v1",
				setId: "set_fedcba9876543210fedcba9876543210",
				tenant: "acme",
				environment: "default",
				campId: "shop",
				planHash: DIGEST_A,
				contentHash: DIGEST_B,
				gateDecisionId: "legacy:deployment:shop@5",
				origin: "SET_ORIGIN_LEGACY_FOLD",
				resolvedSetDigest: DIGEST_C,
				resolvedSetBytes: "1024",
				createdAt: "2026-11-12T00:00:00.000Z",
			},
		]),
		v1(CD_EVENTS.DeltaOpened, DELTA_FIELDS, [
			{
				schemaVersion: "hobo.cd.delta/v1",
				deltaId: "delta-1",
				campId: "prod-aws",
				freightId: FREIGHT,
				changes: [ADD_API],
				openedBy: "user:ops@example.test",
				openedAt: "2026-11-12T00:00:00.000Z",
				intent: "up",
			},
		]),
		v1(CD_EVENTS.DeltaUpdated, DELTA_FIELDS, [
			{
				schemaVersion: "hobo.cd.delta/v1",
				deltaId: "delta-2",
				campId: "prod-aws",
				baseSetId: "set_0123456789abcdef0123456789abcdef",
				freightId: FREIGHT,
				changes: [UPDATE_API],
				infrastructureDiff: [UPDATE_API],
				openedBy: "agent:reconciler-1",
				proposal: true,
				openedAt: "2026-11-12T00:00:00.000Z",
				intent: "promote",
			},
		]),
		v1(CD_EVENTS.DeltaApplied, DECISION_FIELDS, [
			{
				deltaId: "delta-1",
				setId: "set_0123456789abcdef0123456789abcdef",
				gateDecisionId: "gate-1",
				decidedAt: "2026-11-12T00:00:01.000Z",
			},
		]),
		v1(CD_EVENTS.DeltaRejected, DECISION_FIELDS, [
			{
				deltaId: "delta-2",
				reasons: [
					canonicalJson({
						code: "window-closed",
						message: "freeze active",
						remediation: "wait for the window",
						subject: "prod-aws",
					}),
				],
				decidedAt: "2026-11-12T00:00:02.000Z",
			},
		]),
	]);

export function setsCorpusBaseline(): CorpusBaseline {
	return createCorpusBaseline(
		SET_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}

const REPEATED_MESSAGES: ReadonlySet<string> = new Set([
	"changes",
	"infrastructureDiff",
	"reasons",
]);

/** The corpus view of a journal body: repeated messages become canonical JSON strings. */
export function toCorpusBody<T>(_type: string, data: T): EventBody {
	const document = toJsonValue(data);
	if (!isJsonObject(document)) return {};
	const body: Record<string, EventBody[string]> = {};
	for (const [key, value] of Object.entries(document)) {
		if (REPEATED_MESSAGES.has(key) && Array.isArray(value)) {
			body[key] = value.map((item) => canonicalJson(item));
		} else if (isText(value) || isFlag(value) || isNumber(value)) {
			body[key] = value;
		} else {
			body[key] = canonicalJson(value);
		}
	}
	return body;
}
