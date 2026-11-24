import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { deepFreeze } from "../parse-utils.js";
import { CAPABILITY_SLOTS, type CapabilitySlot } from "./capability-slot.js";
import type { HttpTransport } from "./http-transport.js";

export const RESOLVER_CONTRACT = "hobo.resource-resolver/v1";

export const RESOLVER_ACTIONS = Object.freeze([
	"create",
	"update",
	"replace",
	"delete",
	"adopt",
	"noop",
] as const);
export type ResolverAction = (typeof RESOLVER_ACTIONS)[number];

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESOLVER_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const DIRECTIVE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const CREDENTIAL_LOCATOR_PATTERN =
	/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]!$&'()*+,;=%]+$/u;
const MAX_CREDENTIAL_REF_LENGTH = 512;
const CREDENTIAL_KEY_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;
const PEM_PATTERN = /-{3,}\s*BEGIN\b/u;
const AUTH_SCHEME_PATTERN = /^(?:bearer|basic|digest)\s/iu;
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./u;

export interface ResolvedResourceRef {
	readonly slot: CapabilitySlot;
	readonly productId: string;
	readonly logicalId: string;
	readonly physicalId?: string;
}

export interface ResolveRequest {
	readonly ref: ResolvedResourceRef;
	readonly desired: JsonObject;
	readonly observed?: JsonObject;
	readonly credentialRef: string;
}

export interface ResolveOutcome {
	readonly contract: typeof RESOLVER_CONTRACT;
	readonly action: ResolverAction;
	readonly physicalId: string;
	readonly outputs: JsonObject;
	readonly diagnostics: readonly string[];
}

export interface ResourceResolver {
	readonly providerId: string;
	readonly productId: string;
	readonly directives?: readonly string[];
	reconcile(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<ResolveOutcome>;
	delete(request: ResolveRequest, transport: HttpTransport): Promise<void>;
	read?(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<ResolveOutcome | undefined>;
	/** Confirm that the exact recorded physical resource is absent. A missing
	 * read alone is not proof: providers must distinguish a scoped 404 from an
	 * incomplete lookup or unavailable observation. */
	observeAbsence?(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<boolean>;
}

export const RESOLVER_ERROR_CODES = Object.freeze([
	"RESOLVER_CREDENTIAL_MISSING",
	"RESOLVER_CREDENTIAL_NOT_A_REF",
	"RESOLVER_PRODUCT_UNSUPPORTED",
	"RESOLVER_PROVIDER_REJECTED",
	"RESOLVER_OUTPUT_UNPARSEABLE",
] as const);
export type ResolverErrorCode = (typeof RESOLVER_ERROR_CODES)[number];

export class ResolverError extends Error {
	readonly code: ResolverErrorCode;
	readonly productId?: string;

	constructor(code: ResolverErrorCode, message: string, productId?: JsonValue) {
		super(message);
		this.name = "ResolverError";
		this.code = code;
		if (isJsonString(productId) && productId.length > 0) {
			this.productId = productId;
		}
	}
}

export function parseResolveRequest(
	input: JsonValue | undefined,
): ResolveRequest {
	const source = expectRecord(
		input,
		"resolve request",
		"RESOLVER_PRODUCT_UNSUPPORTED",
	);
	const ref = parseResolvedResourceRef(source.ref);
	const credentialRef = parseCredentialRef(source.credentialRef, ref.productId);
	const desired = canonicalizeBag(
		source.desired,
		"desired",
		ref.productId,
		"RESOLVER_PRODUCT_UNSUPPORTED",
	);
	const observed =
		source.observed === undefined
			? undefined
			: canonicalizeBag(
					source.observed,
					"observed",
					ref.productId,
					"RESOLVER_PRODUCT_UNSUPPORTED",
				);

	return deepFreeze({
		ref,
		desired,
		...(observed !== undefined ? { observed } : undefined),
		credentialRef,
	});
}

export function parseResolveOutcome(
	input: JsonValue | undefined,
): ResolveOutcome {
	const source = expectRecord(
		input,
		"resolve outcome",
		"RESOLVER_OUTPUT_UNPARSEABLE",
	);
	if (source.contract !== RESOLVER_CONTRACT) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`contract: expected ${JSON.stringify(RESOLVER_CONTRACT)}, received ${JSON.stringify(source.contract)}`,
		);
	}
	const rawAction = source.action;
	const action = RESOLVER_ACTIONS.find((candidate) => candidate === rawAction);
	if (action === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`action: expected ${RESOLVER_ACTIONS.join(" | ")}, received ${JSON.stringify(rawAction)}; an outcome that cannot name its action cannot tell a create from a duplicate`,
		);
	}
	const physicalId = source.physicalId;
	if (!isJsonString(physicalId) || physicalId.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`physicalId: expected the provider-assigned id as a non-empty string, received ${JSON.stringify(physicalId)}`,
		);
	}
	const outputs = canonicalizeBag(
		source.outputs,
		"outputs",
		undefined,
		"RESOLVER_OUTPUT_UNPARSEABLE",
	);
	const diagnostics = parseDiagnostics(source.diagnostics);

	return deepFreeze({
		contract: RESOLVER_CONTRACT,
		action,
		physicalId,
		outputs,
		diagnostics,
	});
}

export function createResolverRegistry(
	resolvers: readonly ResourceResolver[],
): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	if (!Array.isArray(resolvers)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"resolver registry: expected an array of resolvers",
		);
	}
	const byProduct = new Map<string, ResourceResolver>();
	for (const resolver of resolvers) {
		assertResolverContract(resolver);
		const existing = byProduct.get(resolver.productId);
		if (existing !== undefined) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`productId ${JSON.stringify(resolver.productId)} is registered by both ${JSON.stringify(existing.providerId)} and ${JSON.stringify(resolver.providerId)}: a duplicate makes the product unroutable, so it is refused rather than shadowed`,
				resolver.productId,
			);
		}
		byProduct.set(resolver.productId, registered(resolver));
	}

	const ordered = Object.freeze(
		[...byProduct.values()].sort((left, right) =>
			compare(left.productId, right.productId),
		),
	);

	return Object.freeze({
		get(productId: string): ResourceResolver | undefined {
			return byProduct.get(productId);
		},
		list(): readonly ResourceResolver[] {
			return ordered;
		},
	});
}

function assertResolverContract(value: ResourceResolver): void {
	for (const field of ["providerId", "productId"] as const) {
		const id = value[field];
		if (!isJsonString(id) || !RESOLVER_ID_PATTERN.test(id)) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`resolver ${field}: expected a lowercase id matching ${RESOLVER_ID_PATTERN.source}, received ${JSON.stringify(id)}`,
			);
		}
	}
	if (!(value.reconcile instanceof Function)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`resolver ${JSON.stringify(value.productId)} is missing the required reconcile() method`,
			value.productId,
		);
	}
	if (!(value.delete instanceof Function)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`resolver ${JSON.stringify(value.productId)} is missing the required delete() method`,
			value.productId,
		);
	}
}

const NO_DIRECTIVES: readonly string[] = Object.freeze([]);

export function parseResolverDirectives(
	resolver: ResourceResolver,
): readonly string[] {
	return directiveList(resolver.directives, resolver.productId);
}

function directiveList(
	directives: ResourceResolver["directives"],
	productId: string,
): readonly string[] {
	if (directives === undefined) return NO_DIRECTIVES;
	const names: string[] = [];
	let wellFormed = isJsonArray(directives);
	const length = isJsonArray(directives) ? directives.length : 0;
	for (let index = 0; wellFormed && index < length; index++) {
		const name = Object.hasOwn(directives, index)
			? directives[index]
			: undefined;
		wellFormed =
			isJsonString(name) &&
			DIRECTIVE_PATTERN.test(name) &&
			!names.includes(name);
		if (isJsonString(name)) names.push(name);
	}
	if (!wellFormed) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`resolver ${JSON.stringify(productId)} directives: expected distinct parameter names matching ${DIRECTIVE_PATTERN.source}, with no holes, received ${JSON.stringify(directives)}`,
			productId,
		);
	}
	return Object.freeze(names);
}

function registered(resolver: ResourceResolver): ResourceResolver {
	const declared = resolver.directives;
	if (declared === undefined) return resolver;
	const directives = directiveList(declared, resolver.productId);
	const observeAbsence = resolver.observeAbsence;
	const view: ResourceResolver = {
		providerId: resolver.providerId,
		productId: resolver.productId,
		directives,
		reconcile: (request, transport) => resolver.reconcile(request, transport),
		delete: (request, transport) => resolver.delete(request, transport),
		...(resolver.read === undefined
			? undefined
			: {
					read: async (request: ResolveRequest, transport: HttpTransport) =>
						resolver.read?.(request, transport),
				}),
		...(observeAbsence === undefined
			? undefined
			: {
					observeAbsence: (
						request: ResolveRequest,
						transport: HttpTransport,
					) => {
						return observeAbsence.call(resolver, request, transport);
					},
				}),
	};
	return Object.freeze(view);
}

function parseResolvedResourceRef(
	value: JsonValue | undefined,
): ResolvedResourceRef {
	const source = expectRecord(
		value,
		"resolve request ref",
		"RESOLVER_PRODUCT_UNSUPPORTED",
	);
	const rawSlot = source.slot;
	const slot = CAPABILITY_SLOTS.find((candidate) => candidate === rawSlot);
	if (slot === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`ref.slot: expected ${CAPABILITY_SLOTS.join(" | ")}, received ${JSON.stringify(rawSlot)}`,
		);
	}
	const productId = source.productId;
	if (!isJsonString(productId) || !RESOLVER_ID_PATTERN.test(productId)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`ref.productId: expected a lowercase id matching ${RESOLVER_ID_PATTERN.source}, received ${JSON.stringify(productId)}; a request that names no product cannot be routed to a resolver`,
		);
	}
	const logicalId = source.logicalId;
	if (!isJsonString(logicalId) || !LOGICAL_ID_PATTERN.test(logicalId)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`ref.logicalId: expected a stable author id matching ${LOGICAL_ID_PATTERN.source}, received ${JSON.stringify(logicalId)}`,
			productId,
		);
	}
	const physicalId = source.physicalId;
	if (
		physicalId !== undefined &&
		(!isJsonString(physicalId) || physicalId.trim().length === 0)
	) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`ref.physicalId: expected a non-empty provider id when present, received ${JSON.stringify(physicalId)}`,
			productId,
		);
	}

	return {
		slot,
		productId,
		logicalId,
		...(physicalId !== undefined ? { physicalId } : undefined),
	};
}

function parseCredentialRef(
	value: JsonValue | undefined,
	productId: string,
): string {
	if (value === undefined || value === null) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"credentialRef: required — a resolver is never called without a locator naming the credential the host will resolve",
			productId,
		);
	}
	if (!isJsonString(value) || value.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`credentialRef: expected a non-empty locator string, received ${describe(value)}`,
			productId,
		);
	}
	const reason = credentialValueLayout(value);
	if (reason !== undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`credentialRef: ${reason} — pass a scheme://… locator the host resolves at call time, never the material itself`,
			productId,
		);
	}
	return value;
}

function credentialValueLayout(value: string): string | undefined {
	if (value.length > MAX_CREDENTIAL_REF_LENGTH) {
		return `it is ${value.length} characters, past the ${MAX_CREDENTIAL_REF_LENGTH}-character locator bound`;
	}
	if (/\s/u.test(value)) {
		return "it contains whitespace, which no locator does";
	}
	if (PEM_PATTERN.test(value)) return "it looks like a PEM block";
	if (AUTH_SCHEME_PATTERN.test(value)) {
		return "it looks like an Authorization header value";
	}
	if (JWT_PATTERN.test(value)) return "it looks like a JWT";
	if (value.includes("@")) {
		return "it embeds userinfo, which is how a connection string carries a password";
	}
	if (!CREDENTIAL_LOCATOR_PATTERN.test(value)) {
		return "it is not a scheme://… locator";
	}
	const query = value.slice(value.indexOf("://") + 3).split("?")[1];
	if (query !== undefined) {
		for (const pair of query.split("&")) {
			const [name = "", inline = ""] = pair.split("=");
			if (CREDENTIAL_KEY_PATTERN.test(name) && inline.length > 0) {
				return `its query carries an inline ${name} parameter`;
			}
		}
	}
	return undefined;
}

function parseDiagnostics(value: JsonValue | undefined): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`diagnostics: expected an array of strings, received ${describe(value)}`,
		);
	}
	const out: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (!isJsonString(entry) || entry.trim().length === 0) {
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`diagnostics[${index}]: expected a non-empty string, received ${describe(entry)}`,
			);
		}
		out.push(entry);
	}
	return Object.freeze(out);
}

function canonicalizeBag(
	value: JsonValue | undefined,
	field: string,
	productId: string | undefined,
	catalogCode: ResolverErrorCode,
): JsonObject {
	if (value === undefined) return {};
	if (value === null || !isJsonObject(value) || Array.isArray(value)) {
		throw new ResolverError(
			catalogCode,
			`${field}: expected a JSON object, received ${describe(value)}`,
			productId,
		);
	}
	return canonicalizeRecord(
		value,
		field,
		productId,
		catalogCode,
		new Set<JsonObject | JsonValue[]>(),
	);
}

function canonicalizeRecord(
	record: JsonObject,
	path: string,
	productId: string | undefined,
	catalogCode: ResolverErrorCode,
	seen: Set<JsonObject | JsonValue[]>,
): JsonObject {
	enterCycleGuard(record, path, productId, catalogCode, seen);
	const out: JsonBag = {};
	for (const key of Object.keys(record).sort(compare)) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_NOT_A_REF",
				`${path}.${key}: a resolver property bag carries no credential material — name the secret with a scheme://… locator and let the host resolve it at call time`,
				productId,
			);
		}
		Object.defineProperty(out, key, {
			value: canonicalizeValue(
				record[key],
				`${path}.${key}`,
				productId,
				catalogCode,
				seen,
			),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	seen.delete(record);
	return out;
}

function canonicalizeValue(
	value: JsonValue | undefined,
	path: string,
	productId: string | undefined,
	catalogCode: ResolverErrorCode,
	seen: Set<JsonObject | JsonValue[]>,
): JsonValue {
	if (value === null || isJsonBoolean(value) || isJsonString(value)) {
		return value;
	}
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value)) {
			throw new ResolverError(
				catalogCode,
				`${path}: ${String(value)} has no JSON representation`,
				productId,
			);
		}
		return value;
	}
	if (Array.isArray(value)) {
		enterCycleGuard(value, path, productId, catalogCode, seen);
		const out = value.map((entry, index) =>
			canonicalizeValue(
				entry,
				`${path}[${index}]`,
				productId,
				catalogCode,
				seen,
			),
		);
		seen.delete(value);
		return out;
	}
	if (isPlainObject(value)) {
		return canonicalizeRecord(value, path, productId, catalogCode, seen);
	}
	throw new ResolverError(
		catalogCode,
		`${path}: expected a JSON-safe value (null, boolean, finite number, string, array, plain object), received ${describe(value)}`,
		productId,
	);
}

function enterCycleGuard(
	value: JsonObject | JsonValue[],
	path: string,
	productId: string | undefined,
	catalogCode: ResolverErrorCode,
	seen: Set<JsonObject | JsonValue[]>,
): void {
	if (seen.has(value)) {
		throw new ResolverError(
			catalogCode,
			`${path}: the property bag contains a cycle, which has no JSON representation`,
			productId,
		);
	}
	seen.add(value);
}

function expectRecord(
	value: JsonValue | undefined,
	label: string,
	code: ResolverErrorCode,
): JsonObject {
	if (value === null || !isJsonObject(value) || Array.isArray(value)) {
		throw new ResolverError(
			code,
			`${label}: expected an object, received ${describe(value)}`,
		);
	}
	return value;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
	if (value === null || !isJsonObject(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function describe(value: JsonValue | undefined): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "an array";
	if (isJsonObject(value)) {
		const name: unknown = value.constructor?.name;
		return isJsonString(name) ? `a ${name} instance` : "a non-plain object";
	}
	return `a ${Object.prototype.toString.call(value)}`;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
