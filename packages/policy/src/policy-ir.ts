import { createHash } from "node:crypto";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonValue,
} from "./json.js";

export const POLICY_IR_SCHEMA_VERSION = "hobo.policy-ir/v1";
export const POLICY_DECIDED_EVENT_TYPE = "policy.Decided";

export const SUBJECT_KINDS = Object.freeze([
	"user",
	"service",
	"agent",
	"system",
]);
export const PHASES = Object.freeze([
	"author",
	"local",
	"test",
	"plan",
	"apply",
	"runtime",
	"observe",
	"train",
	"promote",
	"repair",
]);
export const EFFECTS = Object.freeze([
	"allow",
	"allow-degraded",
	"deny",
	"warn",
	"mutate",
	"require-approval",
]);

// Mirrors the ADR-0146 classification vocabulary pinned in
// data-models/compliance.cue — kept local because this package is
// deliberately dependency-free.
export const DATA_CLASSIFICATIONS = Object.freeze([
	"public",
	"internal",
	"pii",
	"phi",
	"pci",
	"secret",
]);

interface PolicySubjectView {
	kind: string;
	id: string;
	roles?: string[];
	scopes?: string[];
	delegatedBy?: string | { kind: string; id: string };
}

const SUBJECT_KIND_SET = new Set(SUBJECT_KINDS);
const PHASE_SET = new Set(PHASES);
const EFFECT_SET = new Set(EFFECTS);
const DATA_CLASSIFICATION_SET = new Set(DATA_CLASSIFICATIONS);

export class PolicyIrValidationError extends Error {
	code: string;
	path: string;

	constructor(code: string, message: string, path = "$") {
		super(`${code} at ${path}: ${message}`);
		this.name = "PolicyIrValidationError";
		this.code = code;
		this.path = path;
	}
}

export function createDecisionRequest(input) {
	return parseDecisionRequest(input);
}

export function parseDecisionRequest(input) {
	const source = expectObject(input, "$");
	assertVersion(source.schemaVersion, "$.schemaVersion");

	if (!Object.hasOwn(source, "subject")) {
		throw new PolicyIrValidationError(
			"missing-subject",
			"policy requests must name a subject explicitly",
			"$.subject",
		);
	}

	const request = {
		schemaVersion: source.schemaVersion,
		subject: parseSubject(source.subject, "$.subject"),
		action: expectNonEmptyString(source.action, "$.action"),
		resource: parseResource(source.resource, "$.resource"),
		phase: parsePhase(source.phase, "$.phase"),
		context:
			source.context === undefined
				? {}
				: canonicalJsonValue(source.context, "$.context"),
	};
	assertDataClassifications(request.context, "$.context.dataClassifications");
	const inputHash = hashDecisionRequest(request);

	if (source.inputHash !== undefined && source.inputHash !== inputHash) {
		throw new PolicyIrValidationError(
			"input-hash-mismatch",
			"provided inputHash does not match canonical request",
			"$.inputHash",
		);
	}

	return { ...request, inputHash };
}

export function createDecision(requestInput, decisionInput) {
	const request = parseDecisionRequest(requestInput);
	return parseDecision(
		{
			schemaVersion: POLICY_IR_SCHEMA_VERSION,
			violations: [],
			mutations: [],
			approvals: [],
			obligations: [],
			...decisionInput,
			evidence: {
				policyIds: [],
				...decisionInput.evidence,
				inputHash: request.inputHash,
			},
		},
		request,
	);
}

export function parseDecision(input, requestInput) {
	const source = expectObject(input, "$");
	assertVersion(source.schemaVersion, "$.schemaVersion");
	const request =
		requestInput === undefined ? undefined : parseDecisionRequest(requestInput);

	const decision = {
		schemaVersion: source.schemaVersion,
		effect: parseEffect(source.effect, "$.effect"),
		reason: expectNonEmptyString(source.reason, "$.reason"),
		violations: parseJsonArray(source.violations ?? [], "$.violations"),
		mutations: parseJsonArray(source.mutations ?? [], "$.mutations"),
		approvals: parseJsonArray(source.approvals ?? [], "$.approvals"),
		obligations: parseObligations(source.obligations ?? [], "$.obligations"),
		evidence: parseEvidence(source.evidence, request, "$.evidence"),
	};

	return decision;
}

export function serializePolicyIrDocument(documentInput) {
	const document = parsePolicyIrDocument(documentInput);
	return canonicalJson(document);
}

export function parsePolicyIrDocument(documentInput) {
	const source = isJsonString(documentInput)
		? expectObject(JSON.parse(documentInput), "$")
		: expectObject(documentInput, "$");
	const request = parseDecisionRequest(source.request);
	const decision = parseDecision(source.decision, request);
	return { request, decision };
}

export function migratePolicyIrDocument(documentInput) {
	const source = expectObject(documentInput, "$");
	if (source.schemaVersion === POLICY_IR_SCHEMA_VERSION) {
		return parseDecisionRequest(source);
	}
	if (source.schemaVersion !== "hobo.policy-ir/v0") {
		throw new PolicyIrValidationError(
			"unsupported-version",
			`cannot migrate ${String(source.schemaVersion)}`,
			"$.schemaVersion",
		);
	}

	return createDecisionRequest({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: {
			kind: source.subjectKind,
			id: source.subjectId,
		},
		action: source.action,
		resource: {
			kind: source.resourceKind,
			id: source.resourceId,
		},
		phase: source.lifecycle,
		context: source.context ?? {},
	});
}

export function createPolicyDecidedEvent<T, D>({
	request: requestInput,
	decision: decisionInput,
	id,
}: {
	request: T;
	decision: D;
	id?: string;
}) {
	const request = parseDecisionRequest(requestInput);
	const decision = parseDecision(decisionInput, request);
	return {
		id:
			id ??
			`policy-decided-${decision.evidence.inputHash.slice("sha256:".length, 18)}`,
		type: POLICY_DECIDED_EVENT_TYPE,
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: request.subject,
		action: request.action,
		resource: request.resource,
		phase: request.phase,
		data: decision,
	};
}

export function toWitDecisionRecord<T, R>(decisionInput: T, requestInput?: R) {
	const decision = parseDecision(decisionInput, requestInput);
	return {
		schema_version: decision.schemaVersion,
		effect: decision.effect,
		reason: decision.reason,
		violations: decision.violations,
		mutations: decision.mutations,
		approvals: decision.approvals,
		obligations: decision.obligations,
		evidence: {
			policy_ids: decision.evidence.policyIds,
			input_hash: decision.evidence.inputHash,
			engine: decision.evidence.engine,
		},
	};
}

export function fromWitDecisionRecord(recordInput, requestInput) {
	const record = expectObject(recordInput, "$");
	return parseDecision(
		{
			schemaVersion: record.schema_version,
			effect: record.effect,
			reason: record.reason,
			violations: record.violations,
			mutations: record.mutations,
			approvals: record.approvals,
			obligations: record.obligations,
			evidence: {
				policyIds: expectObject(record.evidence, "$.evidence").policy_ids,
				inputHash: expectObject(record.evidence, "$.evidence").input_hash,
				engine: expectObject(record.evidence, "$.evidence").engine,
			},
		},
		requestInput,
	);
}

export function hashDecisionRequest(requestInput) {
	const source = expectObject(requestInput, "$");
	const request = {
		schemaVersion: source.schemaVersion,
		subject: source.subject,
		action: source.action,
		resource: source.resource,
		phase: source.phase,
		context: source.context ?? {},
	};
	const digest = createHash("sha256")
		.update(canonicalJson(request))
		.digest("hex");
	return `sha256:${digest}`;
}

export function canonicalJson(value) {
	return JSON.stringify(canonicalJsonValue(value));
}

function assertVersion(version, path) {
	if (version !== POLICY_IR_SCHEMA_VERSION) {
		throw new PolicyIrValidationError(
			"unsupported-version",
			`expected ${POLICY_IR_SCHEMA_VERSION}`,
			path,
		);
	}
}

function parseSubject(input, path) {
	const subject = expectObject(input, path);
	const kind = expectNonEmptyString(subject.kind, `${path}.kind`);
	if (!SUBJECT_KIND_SET.has(kind)) {
		throw new PolicyIrValidationError(
			"unknown-subject-kind",
			kind,
			`${path}.kind`,
		);
	}
	const parsed: PolicySubjectView = {
		kind,
		id: expectNonEmptyString(subject.id, `${path}.id`),
	};
	if (subject.roles !== undefined) {
		parsed.roles = parseStringArray(subject.roles, `${path}.roles`);
	}
	if (subject.scopes !== undefined) {
		parsed.scopes = parseStringArray(subject.scopes, `${path}.scopes`);
	}
	if (subject.delegatedBy !== undefined) {
		parsed.delegatedBy = parseDelegatedBy(
			subject.delegatedBy,
			`${path}.delegatedBy`,
		);
	}
	return parsed;
}

function parseDelegatedBy(input, path) {
	if (isJsonString(input)) {
		return expectNonEmptyString(input, path);
	}
	const delegatedBy = expectObject(input, path);
	return {
		kind: parseSubjectKind(delegatedBy.kind, `${path}.kind`),
		id: expectNonEmptyString(delegatedBy.id, `${path}.id`),
	};
}

function parseSubjectKind(input, path) {
	const kind = expectNonEmptyString(input, path);
	if (!SUBJECT_KIND_SET.has(kind)) {
		throw new PolicyIrValidationError("unknown-subject-kind", kind, path);
	}
	return kind;
}

function parseResource(input, path) {
	const resource = expectObject(input, path);
	return {
		kind: expectNonEmptyString(resource.kind, `${path}.kind`),
		id: expectNonEmptyString(resource.id, `${path}.id`),
	};
}

function parsePhase(input, path) {
	const phase = expectNonEmptyString(input, path);
	if (!PHASE_SET.has(phase)) {
		throw new PolicyIrValidationError("unknown-phase", phase, path);
	}
	return phase;
}

function parseEffect(input, path) {
	const effect = expectNonEmptyString(input, path);
	if (!EFFECT_SET.has(effect)) {
		throw new PolicyIrValidationError("unknown-effect", effect, path);
	}
	return effect;
}

// context.dataClassifications is the one context key with pinned semantics
// (ADR-0146): when present it must be an array drawn from the classification
// vocabulary, so residency-aware packs can trust it without re-parsing.
function assertDataClassifications(context, path) {
	if (
		context === null ||
		!isJsonObject(context) ||
		!Object.hasOwn(context, "dataClassifications")
	) {
		return;
	}
	const value = context.dataClassifications;
	if (!Array.isArray(value)) {
		throw new PolicyIrValidationError(
			"invalid-data-classifications",
			"dataClassifications must be an array of classification labels",
			path,
		);
	}
	for (const [index, entry] of value.entries()) {
		if (!DATA_CLASSIFICATION_SET.has(entry)) {
			throw new PolicyIrValidationError(
				"unknown-data-classification",
				String(entry),
				`${path}[${index}]`,
			);
		}
	}
}

function parseEvidence(input, request, path) {
	const evidence = expectObject(input, path);
	const parsed = {
		policyIds: parseStringArray(evidence.policyIds, `${path}.policyIds`),
		inputHash: expectNonEmptyString(evidence.inputHash, `${path}.inputHash`),
		engine: expectNonEmptyString(evidence.engine, `${path}.engine`),
	};
	if (!/^sha256:[a-f0-9]{64}$/.test(parsed.inputHash)) {
		throw new PolicyIrValidationError(
			"invalid-input-hash",
			parsed.inputHash,
			`${path}.inputHash`,
		);
	}
	if (request !== undefined && parsed.inputHash !== request.inputHash) {
		throw new PolicyIrValidationError(
			"input-hash-mismatch",
			"decision evidence must cite the request hash",
			`${path}.inputHash`,
		);
	}
	return parsed;
}

function parseObligations(input, path) {
	const obligations = parseJsonArray(input, path);
	return obligations.map((obligation, index) => {
		const parsed = expectObject(obligation, `${path}[${index}]`);
		expectNonEmptyString(parsed.kind, `${path}[${index}].kind`);
		return parsed;
	});
}

function parseJsonArray(input, path) {
	if (!Array.isArray(input)) {
		throw new PolicyIrValidationError(
			"expected-array",
			"expected an array",
			path,
		);
	}
	return input.map((item, index) =>
		canonicalJsonValue(item, `${path}[${index}]`),
	);
}

function parseStringArray(input, path) {
	if (!Array.isArray(input)) {
		throw new PolicyIrValidationError(
			"expected-array",
			"expected an array",
			path,
		);
	}
	return input.map((item, index) =>
		expectNonEmptyString(item, `${path}[${index}]`),
	);
}

function expectNonEmptyString(input, path) {
	if (!isJsonString(input) || input.trim() === "") {
		throw new PolicyIrValidationError(
			"expected-string",
			"expected a non-empty string",
			path,
		);
	}
	return input;
}

function expectObject(input, path) {
	if (!isPlainObject(input)) {
		throw new PolicyIrValidationError(
			"expected-object",
			"expected a JSON object",
			path,
		);
	}
	return input;
}

function isPlainObject(input) {
	return (
		input !== null &&
		isJsonObject(input) &&
		!Array.isArray(input) &&
		(Object.getPrototypeOf(input) === Object.prototype ||
			Object.getPrototypeOf(input) === null)
	);
}

function canonicalJsonValue<T>(input: T, path = "$"): JsonValue {
	if (Array.isArray(input)) {
		return input.map((item, index) =>
			canonicalJsonValue(item, `${path}[${index}]`),
		);
	}
	if (input === null) {
		return null;
	}
	if (isJsonString(input) || isJsonBoolean(input)) {
		return input;
	}
	if (isJsonNumber(input)) {
		if (!Number.isFinite(input)) {
			throw new PolicyIrValidationError(
				"invalid-json-number",
				"number must be finite",
				path,
			);
		}
		return input;
	}
	if (isPlainObject(input)) {
		const output: JsonBag = {};
		for (const key of Object.keys(input).sort()) {
			if (input[key] === undefined) {
				throw new PolicyIrValidationError(
					"invalid-json-value",
					"undefined is not valid JSON",
					`${path}.${key}`,
				);
			}
			output[key] = canonicalJsonValue(input[key], `${path}.${key}`);
		}
		return output;
	}
	throw new PolicyIrValidationError(
		"invalid-json-value",
		"expected a JSON value",
		path,
	);
}
