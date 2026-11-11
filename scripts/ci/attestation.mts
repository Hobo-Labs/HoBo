/**
 * The signed record of a local CI run, and the check a workflow makes before
 * it skips the jobs that record covers.
 *
 * A run on a developer's machine executes a pull request's CI jobs against one
 * git tree and signs what it ran. The route job, on a GitHub-hosted machine,
 * verifies that record against the tree it checked out and the keys trusted at
 * the base commit; the covered jobs are then skipped, not re-run.
 *
 * Nothing here is imported from a package and nothing is installed: the route
 * job has only Node. Verification is fail-closed: anything that does not
 * parse, match or verify is "not attested", and CI runs as it always did.
 */
import {
	createHash,
	createPublicKey,
	sign as edSign,
	verify as edVerify,
	type KeyObject,
} from "node:crypto";

/** Versioned: a change to what a statement means gets a new string, and old records stop matching. */
export const ATTESTATION_PREDICATE_TYPE =
	"https://hobo.dev/attestations/ci-local-run/v1";
export const ATTESTATION_SIGNATURE_ALGORITHM = "ed25519";
/** The orphan branch attestations are published on, one file per tested tree. */
export const ATTESTATION_BRANCH = "ci-attestations";
/** Read at the base commit only, so a pull request cannot trust its own key. */
export const ATTESTORS_PATH = ".hobo/ci-attestors.json";

export const ATTESTATION_EVENTS = ["pull_request", "merge_group"] as const;
export type AttestationEvent = (typeof ATTESTATION_EVENTS)[number];

/**
 * The workflow jobs a local run may stand in for. A job id not on this list
 * is never reported as attested, whatever a statement says.
 */
export const COVERED_JOBS = [
	"pr_gate_validation",
	"workspace_tests",
	"pr_affected",
	"pr-offpath",
	"artifact-trust",
	"ci-guard",
	"secret-scan",
	"release-contract",
] as const;
export type CoveredJob = (typeof COVERED_JOBS)[number];

/**
 * The jobs the PR impact gate adds up. Each needs the one before it, so they
 * are attested together or not at all.
 */
export const GATE_JOBS: readonly CoveredJob[] = [
	"pr_gate_validation",
	"workspace_tests",
	"pr_affected",
];

/** The gate's jobs that run on each event; `pr_affected` is pull-request only. */
export const GATE_JOBS_BY_EVENT = {
	pull_request: GATE_JOBS,
	merge_group: ["pr_gate_validation", "workspace_tests"],
} satisfies Record<AttestationEvent, readonly CoveredJob[]>;

/**
 * Jobs whose tests start containers. Without a Docker engine those tests skip
 * silently, so such a job is never signed for, or accepted from, a machine
 * where none answered.
 */
export const NEEDS_CONTAINER_ENGINE: readonly CoveredJob[] = [
	"workspace_tests",
];

/**
 * Jobs that examine commits, not a tree: the secret scan reads every commit
 * between the base and the head. Two histories can end in the same tree, so
 * these are accepted only for the exact head and base commits that were run.
 */
export const COMMIT_BOUND_JOBS: readonly CoveredJob[] = ["secret-scan"];

/** No trust entry may reach further into the future than this. */
export const MAX_TRUST_DAYS = 90;

export function attestationPath(tree: string): string {
	return `attestations/${tree}.json`;
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
export interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
	// SAFETY: the tag check proves a plain object, which JSON.parse only produces as a JsonObject.
	return tagOf.call(value) === "[object Object]"
		? (value as JsonObject)
		: undefined;
}
export function asText(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive.
	return tagOf.call(value) === "[object String]"
		? (value as string)
		: undefined;
}
export function asNumber(value: JsonValue | undefined): number | undefined {
	// SAFETY: the tag check proves a number primitive.
	return tagOf.call(value) === "[object Number]"
		? (value as number)
		: undefined;
}
export function asBoolean(value: JsonValue | undefined): boolean | undefined {
	// SAFETY: the tag check proves a boolean primitive.
	return tagOf.call(value) === "[object Boolean]"
		? (value as boolean)
		: undefined;
}
export function asList(
	value: JsonValue | undefined,
): readonly JsonValue[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

export function parseJson(text: string): JsonValue {
	// SAFETY: a JSON document is a JsonValue by construction.
	return JSON.parse(text) as JsonValue;
}

/**
 * Key-sorted JSON with no whitespace: one document, one byte string, whatever
 * order its keys were written in. Keys sort by code unit, not by locale.
 */
export function canonicalJson(value: JsonValue): string {
	const list = asList(value);
	if (list) return `[${list.map(canonicalJson).join(",")}]`;
	const object = asObject(value);
	if (object)
		return `{${Object.keys(object)
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`,
			)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function sha256Digest(bytes: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Versions of the tools that ran the commands, as each tool reported it. */
export type AttestationTools = Readonly<{
	node: string;
	pnpm: string;
	turbo: string;
	/** The engine's version; present exactly when an engine answered. */
	docker?: string;
}>;

/** What the machine that ran the jobs looked like. Every field is observed, none assumed. */
export type AttestationEnvironment = Readonly<{
	platform: string;
	/** Whether a Docker engine answered when the run started. */
	dockerEngine: boolean;
	tools: AttestationTools;
}>;

export type AttestedJobResult = Readonly<{
	id: string;
	status: "passed";
	/** The events this job's commands ran for. It is accepted for those and no others. */
	events: readonly string[];
	/** Commands that ran for this job, across every event it covers. */
	commands: number;
	durationMs: number;
	/** Digest of the job's combined output, kept on the machine that ran it. */
	logDigest: string;
}>;

export type AttestationStatement = Readonly<{
	predicateType: string;
	/** Tree of the tested commit. */
	tree: string;
	/** Tree of the base it was tested against. */
	baseTree: string;
	/** The tested commit and its base. Jobs that examine commits are bound to these. */
	head: string;
	base: string;
	jobs: readonly string[];
	events: readonly string[];
	startedAt: string;
	finishedAt: string;
	/** Id of the trust entry whose key signed this. */
	attestor: string;
	environment: AttestationEnvironment;
	results: readonly AttestedJobResult[];
}>;

export type AttestationEnvelope = Readonly<{
	statement: AttestationStatement;
	signature: Readonly<{
		algorithm: typeof ATTESTATION_SIGNATURE_ALGORITHM;
		keyId: string;
		value: string;
	}>;
}>;

export type TrustedAttestor = Readonly<{
	id: string;
	/** SPKI, as PEM or as base64 DER. */
	publicKey: string;
	expiresAt: string;
	note: string;
}>;

/** Thrown for a document that is not the shape it must be; the message says what. */
export class AttestationFormatError extends Error {}

function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new AttestationFormatError(what);
	return value;
}

function textList(value: JsonValue | undefined, what: string): string[] {
	return required(asList(value), `${what} must be a list`).map((entry) =>
		required(asText(entry), `${what} must hold only strings`),
	);
}

const TREE_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;

/** Milliseconds for a strict ISO-8601 UTC instant (`2026-01-31T00:00:00Z`); undefined for anything else. */
export function utcInstant(text: string): number | undefined {
	if (!ISO_UTC_PATTERN.test(text)) return undefined;
	const ms = Date.parse(text);
	if (Number.isNaN(ms)) return undefined;
	// A date that does not exist (the 31st of February) parses to another day.
	return new Date(ms).toISOString().slice(0, 19) === text.slice(0, 19)
		? ms
		: undefined;
}

export function isObjectId(value: string): boolean {
	return TREE_PATTERN.test(value);
}

/** An ed25519 public key from SPKI PEM or base64 DER; anything else throws. */
export function publicKeyFrom(text: string): KeyObject {
	const trimmed = text.trim();
	const key = trimmed.includes("-----BEGIN")
		? createPublicKey(trimmed)
		: createPublicKey({
				key: Buffer.from(trimmed, "base64"),
				format: "der",
				type: "spki",
			});
	if (key.asymmetricKeyType !== "ed25519")
		throw new AttestationFormatError("an attestor key must be ed25519");
	return key;
}

/** A public key as the base64 DER a trust entry holds. */
export function publicKeyText(key: KeyObject): string {
	return key.export({ type: "spki", format: "der" }).toString("base64");
}

/** A stable id for a key: the start of its SPKI digest. */
export function keyIdOf(key: KeyObject): string {
	const digest = createHash("sha256")
		.update(key.export({ type: "spki", format: "der" }))
		.digest("hex");
	return `ed25519-${digest.slice(0, 16)}`;
}

/**
 * The trusted attestors in one `.hobo/ci-attestors.json`. Every entry needs
 * its key's own id, a usable ed25519 key, a strict UTC expiry and a note, and
 * ids may not repeat. With `nowMs`, an expiry more than `MAX_TRUST_DAYS` away
 * is refused too: a list that trusts a key for longer is not a list to act on.
 */
export function parseAttestors(
	text: string,
	nowMs?: number,
): TrustedAttestor[] {
	const entries = required(
		asList(parseJson(text)),
		"the attestor list must be a JSON array",
	);
	const attestors = entries.map((entry, index) => {
		const at = `attestor ${index}`;
		const object = required(asObject(entry), `${at} must be an object`);
		const id = required(asText(object.id), `${at} needs an id`);
		const publicKey = required(
			asText(object.publicKey),
			`${at} needs a publicKey`,
		);
		const expiresAt = required(
			asText(object.expiresAt),
			`${at} needs an expiresAt`,
		);
		const note = required(asText(object.note), `${at} needs a note`);
		if (!ID_PATTERN.test(id))
			throw new AttestationFormatError(`${at} has an unusable id`);
		const expiry = utcInstant(expiresAt);
		if (expiry === undefined)
			throw new AttestationFormatError(
				`${at} needs an expiresAt in ISO-8601 UTC, such as 2026-01-31T00:00:00Z`,
			);
		let key: KeyObject;
		try {
			key = publicKeyFrom(publicKey);
		} catch {
			throw new AttestationFormatError(`${at} has an unusable publicKey`);
		}
		if (keyIdOf(key) !== id)
			throw new AttestationFormatError(
				`${at} must have its key's own id, ${keyIdOf(key)}`,
			);
		if (
			nowMs !== undefined &&
			expiry - nowMs > MAX_TRUST_DAYS * 24 * 60 * 60 * 1000
		)
			throw new AttestationFormatError(
				`${at} expires more than ${MAX_TRUST_DAYS} days from now`,
			);
		return { id, publicKey, expiresAt, note };
	});
	if (
		new Set(attestors.map((attestor) => attestor.id)).size !== attestors.length
	)
		throw new AttestationFormatError("attestor ids must not repeat");
	return attestors;
}

function parseEnvironment(
	value: JsonValue | undefined,
): AttestationEnvironment {
	const object = required(asObject(value), "environment must be an object");
	const source = required(
		asObject(object.tools),
		"environment.tools must be an object",
	);
	const dockerEngine = required(
		asBoolean(object.dockerEngine),
		"environment.dockerEngine is missing",
	);
	const node = required(
		asText(source.node),
		"environment.tools.node is missing",
	);
	const pnpm = required(
		asText(source.pnpm),
		"environment.tools.pnpm is missing",
	);
	const turbo = required(
		asText(source.turbo),
		"environment.tools.turbo is missing",
	);
	const docker = asText(source.docker);
	const tools: AttestationTools =
		docker === undefined
			? { node, pnpm, turbo }
			: { node, pnpm, turbo, docker };
	// An engine's version is evidence that one answered, and only that.
	if (dockerEngine !== (docker !== undefined))
		throw new AttestationFormatError(
			"environment.tools.docker must be present exactly when dockerEngine is true",
		);
	return {
		platform: required(
			asText(object.platform),
			"environment.platform is missing",
		),
		dockerEngine,
		tools,
	};
}

function parseResult(value: JsonValue): AttestedJobResult {
	const object = required(asObject(value), "a result must be an object");
	const status = required(asText(object.status), "a result needs a status");
	if (status !== "passed")
		throw new AttestationFormatError("a result must have passed");
	return {
		id: required(asText(object.id), "a result needs an id"),
		status,
		events: textList(object.events, "a result's events"),
		commands: required(asNumber(object.commands), "a result needs commands"),
		durationMs: required(
			asNumber(object.durationMs),
			"a result needs durationMs",
		),
		logDigest: required(asText(object.logDigest), "a result needs logDigest"),
	};
}

/** A git object id, and nothing a log line could be broken with. */
function objectId(value: JsonValue | undefined, what: string): string {
	const id = required(asText(value), `${what} is missing`);
	if (!isObjectId(id))
		throw new AttestationFormatError(`${what} is not a git object id`);
	return id;
}

/** A key id of the shape trust entries use; it is printed, so it is checked first. */
function keyId(value: JsonValue | undefined, what: string): string {
	const id = required(asText(value), `${what} is missing`);
	if (!ID_PATTERN.test(id))
		throw new AttestationFormatError(`${what} is not a usable key id`);
	return id;
}

function parseStatement(value: JsonValue | undefined): AttestationStatement {
	const object = required(asObject(value), "statement must be an object");
	return {
		predicateType: required(
			asText(object.predicateType),
			"statement.predicateType is missing",
		),
		tree: objectId(object.tree, "statement.tree"),
		baseTree: objectId(object.baseTree, "statement.baseTree"),
		head: objectId(object.head, "statement.head"),
		base: objectId(object.base, "statement.base"),
		jobs: textList(object.jobs, "statement.jobs"),
		events: textList(object.events, "statement.events"),
		startedAt: required(
			asText(object.startedAt),
			"statement.startedAt is missing",
		),
		finishedAt: required(
			asText(object.finishedAt),
			"statement.finishedAt is missing",
		),
		attestor: keyId(object.attestor, "statement.attestor"),
		environment: parseEnvironment(object.environment),
		results: required(
			asList(object.results),
			"statement.results must be a list",
		).map(parseResult),
	};
}

type ParsedEnvelope = Readonly<{
	envelope: AttestationEnvelope;
	/** The statement exactly as it was written, which is what was signed. */
	signed: JsonValue;
}>;

function parseEnvelopeDocument(text: string): ParsedEnvelope {
	const object = required(
		asObject(parseJson(text)),
		"an attestation must be a JSON object",
	);
	const signature = required(
		asObject(object.signature),
		"signature must be an object",
	);
	const algorithm = required(
		asText(signature.algorithm),
		"signature.algorithm is missing",
	);
	if (algorithm !== ATTESTATION_SIGNATURE_ALGORITHM)
		throw new AttestationFormatError("signature.algorithm must be ed25519");
	return {
		envelope: {
			statement: parseStatement(object.statement),
			signature: {
				algorithm,
				keyId: keyId(signature.keyId, "signature.keyId"),
				value: required(asText(signature.value), "signature.value is missing"),
			},
		},
		signed: object.statement ?? null,
	};
}

export function parseEnvelope(text: string): AttestationEnvelope {
	return parseEnvelopeDocument(text).envelope;
}

function statementJson(statement: AttestationStatement): JsonValue {
	return parseJson(JSON.stringify(statement));
}

export function signStatement(
	statement: AttestationStatement,
	privateKey: KeyObject,
): AttestationEnvelope {
	const bytes = Buffer.from(canonicalJson(statementJson(statement)), "utf8");
	return {
		statement,
		signature: {
			algorithm: ATTESTATION_SIGNATURE_ALGORITHM,
			keyId: statement.attestor,
			value: edSign(null, bytes, privateKey).toString("base64"),
		},
	};
}

export type AttestationVerdict =
	| Readonly<{ attested: true; jobs: readonly CoveredJob[]; attestor: string }>
	| Readonly<{ attested: false; reason: string }>;

const refused = (reason: string): AttestationVerdict => ({
	attested: false,
	reason,
});

/**
 * Whether `envelopeText` is a signed record of a run on exactly `tree`,
 * tested against exactly `baseTree`, covering `event`, by a key that
 * `attestorsText` trusts and that has not expired.
 *
 * `attestorsText` must be the attestor list as it is at the base commit. The
 * caller reads it there and nowhere else: the list in the tree under test is
 * the pull request's own, and a pull request may not vouch for itself.
 *
 * The jobs reported are those that ran for `event` on a machine able to run
 * them. A job that examines commits (the secret scan) is reported only when
 * `head` and `base`, the event's own commits, are the commits that were run:
 * another history can end in the same tree.
 */
export function verifyAttestation(input: {
	envelopeText: string;
	attestorsText: string;
	tree: string;
	baseTree: string;
	event: string;
	nowMs: number;
	/** The event's head commit, when it has one (`pull_request.head.sha`). */
	head?: string | undefined;
	/** The event's base commit. */
	base?: string | undefined;
}): AttestationVerdict {
	let parsed: ParsedEnvelope;
	let attestors: TrustedAttestor[];
	try {
		parsed = parseEnvelopeDocument(input.envelopeText);
	} catch (cause) {
		return refused(
			`the attestation is malformed (${cause instanceof Error ? cause.message : "unreadable"})`,
		);
	}
	try {
		attestors = parseAttestors(input.attestorsText, input.nowMs);
	} catch (cause) {
		return refused(
			`the trusted attestor list at the base is malformed (${cause instanceof Error ? cause.message : "unreadable"})`,
		);
	}
	const { statement, signature } = parsed.envelope;
	if (statement.predicateType !== ATTESTATION_PREDICATE_TYPE)
		return refused("the attestation is of another kind or version");
	if (statement.attestor !== signature.keyId)
		return refused("the statement and its signature name different keys");
	const attestor = attestors.find((entry) => entry.id === signature.keyId);
	if (!attestor)
		return refused(
			`key ${signature.keyId} is not a trusted attestor at the base commit`,
		);
	if (!(input.nowMs < (utcInstant(attestor.expiresAt) ?? 0)))
		return refused(
			`trusted attestor ${attestor.id} expired at ${attestor.expiresAt}`,
		);
	let signatureHolds = false;
	try {
		signatureHolds = edVerify(
			null,
			Buffer.from(canonicalJson(parsed.signed), "utf8"),
			publicKeyFrom(attestor.publicKey),
			Buffer.from(signature.value, "base64"),
		);
	} catch {
		signatureHolds = false;
	}
	if (!signatureHolds) return refused("the signature does not verify");
	if (!isObjectId(input.tree) || statement.tree !== input.tree)
		return refused("the attestation is for another tree");
	if (!isObjectId(input.baseTree) || statement.baseTree !== input.baseTree)
		return refused("the attestation was tested against another base");
	const event = ATTESTATION_EVENTS.find((known) => known === input.event);
	if (!event || !statement.events.includes(event))
		return refused(`the attestation does not cover ${input.event}`);
	const results = new Map(
		statement.results.map((result) => [result.id, result]),
	);
	if (statement.jobs.some((job) => !results.has(job)))
		return refused("a job is listed without a passing result");
	// Only what ran for this event, on a machine that could run it.
	let jobs = COVERED_JOBS.filter(
		(job) =>
			statement.jobs.includes(job) &&
			results.get(job)?.events.includes(event) === true,
	);
	if (!statement.environment.dockerEngine)
		jobs = jobs.filter((job) => !NEEDS_CONTAINER_ENGINE.includes(job));
	const sameCommits =
		input.head !== undefined &&
		input.base !== undefined &&
		isObjectId(input.head) &&
		isObjectId(input.base) &&
		statement.head === input.head &&
		statement.base === input.base;
	if (!sameCommits)
		jobs = jobs.filter((job) => !COMMIT_BOUND_JOBS.includes(job));
	if (!GATE_JOBS_BY_EVENT[event].every((job) => jobs.includes(job)))
		jobs = jobs.filter((job) => !GATE_JOBS.includes(job));
	if (jobs.length === 0) return refused("the attestation covers no job");
	return { attested: true, jobs, attestor: attestor.id };
}
