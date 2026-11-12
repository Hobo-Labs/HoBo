// Canonical JSON lowering/lifting of hobo:resolver WIT values. Both sides of
// the boundary parse what they receive — parse, don't validate: the host
// lifts every guest value into the parsed derived types in ./types.ts before
// trusting it, and a malformed value is an `AbiError`, never a guess.
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type {
	WitDescription,
	WitEgressResult,
	WitHeader,
	WitHttpRequest,
	WitHttpResponse,
	WitInstance,
	WitLogLevel,
	WitReadResult,
	WitResolveOutcome,
	WitResolverAction,
	WitResolverError,
	WitResolveRequest,
	WitResourceClass,
	WitResult,
} from "./types.js";

/** A value crossed the boundary outside the WIT contract. */
export class AbiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AbiError";
	}
}

const ACTIONS: readonly WitResolverAction[] = [
	"create",
	"update",
	"replace",
	"delete",
	"adopt",
	"noop",
];
const LOG_LEVELS: readonly WitLogLevel[] = ["debug", "info", "warn", "error"];

/** Lower any WIT value (already JSON-compatible) to a JSON value. */
export function lower(value: WitValue): JsonValue {
	const lowered: JsonValue = JSON.parse(JSON.stringify(value) ?? "null");
	return lowered;
}

/** Every WIT value this ABI lowers. */
export type WitValue =
	| WitDescription
	| WitEgressResult
	| WitHttpRequest
	| WitHttpResponse
	| WitResolveRequest
	| WitResult<WitResolveOutcome>
	| WitResult<WitReadResult | null>
	| WitResult<null>
	| WitResult<readonly WitInstance[]>
	| AuthorizedFetchPayload
	| LogPayload
	| InstancesPayload
	| null;

export interface AuthorizedFetchPayload {
	readonly request: WitHttpRequest;
	readonly credentialRef: string;
}
export interface LogPayload {
	readonly level: WitLogLevel;
	readonly message: string;
}
export interface InstancesPayload {
	readonly productId: string;
	readonly credentialRef: string;
}

export function object(value: JsonValue | undefined, label: string): JsonObject {
	if (value === undefined || value === null || !isJsonObject(value) || isJsonArray(value))
		throw new AbiError(`${label}: expected a record`);
	return value;
}

export function string(value: JsonValue | undefined, label: string): string {
	if (!isJsonString(value)) throw new AbiError(`${label}: expected a string`);
	return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | null {
	if (value === undefined || value === null) return null;
	return string(value, label);
}

function stringList(value: JsonValue | undefined, label: string): readonly string[] {
	if (!isJsonArray(value)) throw new AbiError(`${label}: expected a list<string>`);
	return Object.freeze(value.map((entry, index) => string(entry, `${label}[${index}]`)));
}

function headers(value: JsonValue | undefined, label: string): readonly WitHeader[] {
	if (!isJsonArray(value))
		throw new AbiError(`${label}: expected list<tuple<string, string>>`);
	return Object.freeze(
		value.map((entry, index): WitHeader => {
			if (!isJsonArray(entry) || entry.length !== 2)
				throw new AbiError(`${label}[${index}]: expected tuple<string, string>`);
			return Object.freeze([
				string(entry[0], `${label}[${index}].0`),
				string(entry[1], `${label}[${index}].1`),
			] as const);
		}),
	);
}

export function liftHttpRequest(value: JsonValue | undefined): WitHttpRequest {
	const source = object(value, "http-request");
	return Object.freeze({
		method: string(source.method, "http-request.method"),
		url: string(source.url, "http-request.url"),
		headers: headers(source.headers, "http-request.headers"),
		body: optionalString(source.body, "http-request.body"),
	});
}

export function liftHttpResponse(value: JsonValue | undefined): WitHttpResponse {
	const source = object(value, "http-response");
	const status = source.status;
	if (!isJsonNumber(status) || !Number.isInteger(status) || status < 0 || status > 65_535)
		throw new AbiError("http-response.status: expected u16");
	return Object.freeze({
		status,
		headers: headers(source.headers, "http-response.headers"),
		body: string(source.body, "http-response.body"),
	});
}

export function liftEgressResult(value: JsonValue | undefined): WitEgressResult {
	const source = object(value, "egress result");
	if (source.ok !== undefined) return Object.freeze({ ok: liftHttpResponse(source.ok) });
	const err = object(source.err, "egress result.err");
	if (err.tag !== "denied") throw new AbiError("egress-error: expected tag denied");
	return Object.freeze({
		err: Object.freeze({ tag: "denied", val: string(err.val, "egress-error.val") }),
	});
}

export function liftAuthorizedFetch(value: JsonValue | undefined): AuthorizedFetchPayload {
	const source = object(value, "authorized-fetch");
	return Object.freeze({
		request: liftHttpRequest(source.request),
		credentialRef: string(source.credentialRef, "authorized-fetch.credential-ref"),
	});
}

export function liftLog(value: JsonValue | undefined): LogPayload {
	const source = object(value, "log");
	const level = LOG_LEVELS.find((candidate) => candidate === source.level);
	if (level === undefined) throw new AbiError("log.level: expected a log-level");
	return Object.freeze({ level, message: string(source.message, "log.message") });
}

export function liftInstancesPayload(value: JsonValue | undefined): InstancesPayload {
	const source = object(value, "instances");
	return Object.freeze({
		productId: string(source.productId, "instances.product-id"),
		credentialRef: string(source.credentialRef, "instances.credential-ref"),
	});
}

export function liftResolveRequest(value: JsonValue | undefined): WitResolveRequest {
	const source = object(value, "resolve-request");
	const ref = object(source.ref, "resolve-request.ref");
	return Object.freeze({
		ref: Object.freeze({
			slot: string(ref.slot, "ref.slot"),
			productId: string(ref.productId, "ref.product-id"),
			logicalId: string(ref.logicalId, "ref.logical-id"),
			physicalId: optionalString(ref.physicalId, "ref.physical-id"),
		}),
		desiredJson: string(source.desiredJson, "resolve-request.desired-json"),
		observedJson: optionalString(source.observedJson, "resolve-request.observed-json"),
		credentialRef: string(source.credentialRef, "resolve-request.credential-ref"),
	});
}

export function liftDescription(value: JsonValue | undefined): WitDescription {
	const source = object(value, "description");
	if (!isJsonArray(source.classes)) throw new AbiError("description.classes: expected a list");
	return Object.freeze({
		componentId: string(source.componentId, "description.component-id"),
		version: string(source.version, "description.version"),
		classes: Object.freeze(
			source.classes.map((entry, index): WitResourceClass => {
				const item = object(entry, `description.classes[${index}]`);
				return Object.freeze({
					productId: string(item.productId, "resource-class.product-id"),
					slot: string(item.slot, "resource-class.slot"),
					retainedFields: stringList(item.retainedFields, "resource-class.retained-fields"),
					observeFields: stringList(item.observeFields, "resource-class.observe-fields"),
					directives: stringList(item.directives, "resource-class.directives"),
				});
			}),
		),
	});
}

export function liftOutcome(value: JsonValue | undefined): WitResolveOutcome {
	const source = object(value, "resolve-outcome");
	const action = ACTIONS.find((candidate) => candidate === source.action);
	if (action === undefined) throw new AbiError("resolve-outcome.action: expected a resolver-action");
	return Object.freeze({
		action,
		physicalId: string(source.physicalId, "resolve-outcome.physical-id"),
		outputsJson: string(source.outputsJson, "resolve-outcome.outputs-json"),
		diagnostics: stringList(source.diagnostics, "resolve-outcome.diagnostics"),
	});
}

export function liftReadResult(value: JsonValue | undefined): WitReadResult | null {
	if (value === null) return null;
	const source = object(value, "read-result");
	return Object.freeze({
		outcome: liftOutcome(source.outcome),
		attributes: headers(source.attributes, "read-result.attributes"),
	});
}

export function liftInstances(value: JsonValue | undefined): readonly WitInstance[] {
	if (!isJsonArray(value)) throw new AbiError("instances: expected list<instance>");
	return Object.freeze(
		value.map((entry, index): WitInstance => {
			const item = object(entry, `instances[${index}]`);
			return Object.freeze({
				logicalId: string(item.logicalId, "instance.logical-id"),
				physicalId: string(item.physicalId, "instance.physical-id"),
			});
		}),
	);
}

export function liftNull(value: JsonValue | undefined): null {
	if (value !== null && value !== undefined) throw new AbiError("expected unit");
	return null;
}

/** Lift a `result<T, resolver-error>` with the given `ok` lifter. */
export function liftResult<T>(
	value: JsonValue | undefined,
	liftOk: (ok: JsonValue | undefined) => T,
): WitResult<T> {
	const source = object(value, "result");
	if (Object.hasOwn(source, "ok")) return Object.freeze({ ok: liftOk(source.ok) });
	const err = object(source.err, "result.err");
	const val = string(err.val, "resolver-error.val");
	let error: WitResolverError;
	if (err.tag === "rejected") error = { tag: "rejected", val };
	else if (err.tag === "unsupported") error = { tag: "unsupported", val };
	else throw new AbiError("resolver-error.tag: expected rejected | unsupported");
	return Object.freeze({ err: Object.freeze(error) });
}
