/**
 * Parse, don't validate: the bindings file crosses this boundary once and
 * becomes frozen `ParsedCredentialBinding`s. Everything downstream (the
 * `.env.schema` renderer, the launch, the SecretsPort) takes the parsed type,
 * so no later function re-checks a string.
 *
 * A binding is a reference: where a credential lives (an OpenSesame
 * connection) and how far a surrogate for it may reach (paths and methods).
 * It never holds a token, and an unbounded scope cannot be written down.
 * The regular expressions below are the ones adapter_opensesame.cue carries;
 * test/binding.test.ts reads them out of that file and compares.
 */

import { parseSecretRef } from "@hobo/bindings";

import type { CredentialBinding } from "./_generated/adapter_opensesame_pb.js";
import { OpenSesameAdapterError } from "./errors.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: the CUE's locator pattern; test/binding.test.ts compares it with adapter_opensesame.cue.
export const LOCATOR_PATTERN = "^hobo-token://[a-z0-9-]+/[a-z0-9-]+$";
// public-contract: the CUE's connection pattern.
export const CONNECTION_PATTERN = "^conn://[a-z0-9-]+(/[a-z0-9-]+){1,2}$";
// public-contract: the CUE's variable-name pattern.
export const ENV_NAME_PATTERN = "^[A-Z][A-Z0-9_]*$";
// public-contract: the CUE's path-prefix pattern.
export const PATH_PATTERN = "^/[A-Za-z0-9._~%/-]+$";
// public-contract: the CUE's refusal of an empty path segment (`//` bounds nothing).
export const PATH_NO_EMPTY_SEGMENT_PATTERN = "//";
// public-contract: the CUE's refusal of a `.` or `..` segment, which walks out of the prefix it was granted.
export const PATH_NO_DOT_SEGMENT_PATTERN = "/\\.{1,2}(/|$)";

/**
 * Variables the run depends on: a surrogate placed in one of them would switch
 * the proxy off (NODE_USE_ENV_PROXY), loop the relaunch (HOBO_OPENSESAME_CHILD),
 * load code (NODE_OPTIONS, LD_PRELOAD, DYLD_*), redirect lookup (PATH, HOME) or
 * break the CA (SSL_*, NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, GIT_SSL_CAINFO).
 * OpenSesame itself refuses to bind the proxy and CA variables (its TRUST_VARS,
 * PROXY_VARS and NO_PROXY_VARS; test/reserved-names-drift.test.ts holds this list
 * to a copy of them); the rest it would place without complaint.
 */
export const RESERVED_ENV_NAMES = [
	"HOBO_OPENSESAME_CHILD",
	"PATH",
	"HOME",
	"SHELL",
	"IFS",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"GIT_SSL_CAINFO",
] as const;
/** Whole families: Node's, OpenSesame's own, and the loaders'. */
export const RESERVED_ENV_PREFIXES = [
	"OPENSESAME",
	"NODE",
	"LD",
	"DYLD",
] as const;
// public-contract: the CUE's reserved-name refusal, built from the two lists above (the only source) and compared with the .cue.
export const RESERVED_ENV_NAME_PATTERN = `^(?:${RESERVED_ENV_NAMES.join("|")}|(?:${RESERVED_ENV_PREFIXES.join("|")})_[A-Z0-9_]*)$`;

/**
 * The verbs a binding may grant. OpenSesame's plugin checks seven; HEAD and
 * OPTIONS are left out because no HoBo client sends them, and a surrogate
 * never gets a verb nobody asked for.
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const locatorRe = new RegExp(LOCATOR_PATTERN, "u");
const connectionRe = new RegExp(CONNECTION_PATTERN, "u");
const envNameRe = new RegExp(ENV_NAME_PATTERN, "u");
const reservedRe = new RegExp(RESERVED_ENV_NAME_PATTERN, "u");
const pathRe = new RegExp(PATH_PATTERN, "u");
const emptySegmentRe = new RegExp(PATH_NO_EMPTY_SEGMENT_PATTERN, "u");
const dotSegmentRe = new RegExp(PATH_NO_DOT_SEGMENT_PATTERN, "u");

/** The generated `CredentialBinding` narrowed to what the CUE allows. */
type ParsedFields = Readonly<
	Omit<CredentialBinding, "$typeName" | "paths" | "methods" | "provider"> & {
		provider: "vercel";
		paths: readonly string[];
		methods: readonly HttpMethod[];
	}
>;

/**
 * A binding that passed `parseCredentialBindings`. It is nominal: the `#brand`
 * is a private field, so a spread copy, an object literal or `Object.assign` has
 * the right public fields and is still not one (a compile error), and
 * `isParsedCredentialBinding` tells a forged value at run time by a module-private
 * registry that only `parseOne` below adds to, after every check. The class is
 * exported as a type only, and constructing a second instance through
 * `binding.constructor` does not register it.
 */
class ParsedCredentialBinding implements ParsedFields {
	readonly #brand = true;
	readonly locator: string;
	readonly connection: string;
	readonly provider: "vercel";
	readonly envName: string;
	readonly paths: readonly string[];
	readonly methods: readonly HttpMethod[];
	readonly projection: string;

	constructor(fields: ParsedFields) {
		this.locator = fields.locator;
		this.connection = fields.connection;
		this.provider = fields.provider;
		this.envName = fields.envName;
		this.paths = Object.freeze([...fields.paths]);
		this.methods = Object.freeze([...fields.methods]);
		this.projection = fields.projection;
		Object.freeze(this);
	}

	static is(value: ParsedFields): value is ParsedCredentialBinding {
		return parsedBindings.has(value) && #brand in value && value.#brand;
	}
}

/**
 * The bindings `parseOne` made. The class is reachable from any instance
 * (`binding.constructor`), so constructing one is not proof of parsing; being in
 * this module-private set is, and nothing outside the module can add to it.
 */
const parsedBindings = new WeakSet<ParsedFields>();

function parsedBy(binding: ParsedCredentialBinding): ParsedCredentialBinding {
	parsedBindings.add(binding);
	return binding;
}

export type { ParsedCredentialBinding };

/** Whether `value` was made by `parseCredentialBindings`, not copied or written. */
export function isParsedCredentialBinding(
	value: ParsedFields,
): value is ParsedCredentialBinding {
	return ParsedCredentialBinding.is(value);
}

const FIELDS = [
	"locator",
	"connection",
	"provider",
	"env_name",
	"paths",
	"methods",
	"projection",
] as const;

const SAFE_KEY = /^[a-z_]{1,32}$/u;

function invalid(where: string, rule: string): OpenSesameAdapterError {
	return new OpenSesameAdapterError("binding_invalid", `${where}: ${rule}`);
}

function str(record: JsonObject, key: string, where: string): string {
	const value = record[key];
	if (!isJsonString(value)) {
		throw invalid(where, `${key} must be a string`);
	}
	return value;
}

function strings(record: JsonObject, key: string, where: string): string[] {
	const value = record[key];
	if (!isJsonArray(value) || value.length === 0) {
		throw invalid(
			where,
			`${key} must be a non-empty list; a surrogate with no declared scope cannot be issued`,
		);
	}
	const out: string[] = [];
	for (const item of value) {
		if (!isJsonString(item)) {
			throw invalid(where, `${key} must hold only strings`);
		}
		out.push(item);
	}
	return out;
}

function notBrokered(provider: string, where: string): OpenSesameAdapterError {
	if (provider === "aws") {
		return new OpenSesameAdapterError(
			"provider_not_brokered",
			`${where}: aws cannot be brokered by a surrogate. AWS requests are signed with SigV4 in process from a live secret key, which header substitution cannot serve, and OpenSesame's AWS helper fails closed until its STS mint exists. Use a bound-resource or federated identity for AWS in the meantime.`,
		);
	}
	return new OpenSesameAdapterError(
		"provider_not_brokered",
		`${where}: this adapter brokers vercel only`,
	);
}

function checkLocator(locator: string, where: string): void {
	if (!locatorRe.test(locator)) {
		throw invalid(where, `locator must match ${LOCATOR_PATTERN}`);
	}
	try {
		if (parseSecretRef(locator).scheme !== "hobo-token") {
			throw invalid(where, "locator must use the hobo-token scheme");
		}
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) throw error;
		throw invalid(where, "locator is not a registered secret reference");
	}
}

function checkPath(path: string, where: string): void {
	if (
		!pathRe.test(path) ||
		emptySegmentRe.test(path) ||
		dotSegmentRe.test(path)
	) {
		throw invalid(
			where,
			"paths must be absolute prefixes of named segments (no empty or dot segment, no query, no list separator)",
		);
	}
}

function isHttpMethod(value: string): value is HttpMethod {
	return HTTP_METHODS.some((method) => method === value);
}

function parseOne(input: JsonValue, index: number): ParsedCredentialBinding {
	const where = `binding[${index}]`;
	if (!isJsonObject(input)) throw invalid(where, "must be an object");
	for (const key of Object.keys(input)) {
		if (!FIELDS.some((field) => field === key)) {
			throw invalid(
				where,
				SAFE_KEY.test(key)
					? `unknown field ${key}; a binding holds references, never a credential`
					: "unknown field; a binding holds references, never a credential",
			);
		}
	}
	const provider = str(input, "provider", where);
	if (provider !== "vercel") throw notBrokered(provider, where);

	const locator = str(input, "locator", where);
	checkLocator(locator, where);
	const connection = str(input, "connection", where);
	if (!connectionRe.test(connection)) {
		throw invalid(where, `connection must match ${CONNECTION_PATTERN}`);
	}
	if (connection.split("/").pop() !== provider) {
		throw invalid(
			where,
			"the last segment of connection names its provider and must equal provider",
		);
	}
	const envName = str(input, "env_name", where);
	if (!envNameRe.test(envName)) {
		throw invalid(where, `env_name must match ${ENV_NAME_PATTERN}`);
	}
	if (reservedRe.test(envName)) {
		throw new OpenSesameAdapterError(
			"reserved_env_name",
			`${where}: env_name is a variable the run depends on; bind the surrogate to a name of its own`,
		);
	}
	if (str(input, "projection", where) !== "legacy-token") {
		throw invalid(where, "projection must be legacy-token");
	}
	const paths = strings(input, "paths", where);
	for (const path of paths) checkPath(path, where);
	const methods: HttpMethod[] = [];
	for (const method of strings(input, "methods", where)) {
		if (!isHttpMethod(method)) {
			throw invalid(where, `methods must be among ${HTTP_METHODS.join(", ")}`);
		}
		methods.push(method);
	}
	return parsedBy(
		new ParsedCredentialBinding({
			locator,
			connection,
			provider,
			envName,
			paths,
			methods,
			projection: "legacy-token",
		}),
	);
}

/**
 * Parse a `hobo.credentials.json` document: `{ "bindings": [ ... ] }`, each
 * binding a snake_case `CredentialBinding` record. Fails closed on the first
 * problem, and never echoes a rejected value.
 */
export function parseCredentialBindings(
	document: JsonValue,
): readonly ParsedCredentialBinding[] {
	if (!isJsonObject(document)) {
		throw invalid("bindings", "must be an object with a bindings list");
	}
	if (Object.keys(document).some((key) => key !== "bindings")) {
		throw invalid("bindings", "only a bindings list is allowed");
	}
	const list = document.bindings;
	if (!isJsonArray(list)) throw invalid("bindings", "bindings must be a list");
	const out: ParsedCredentialBinding[] = [];
	for (const [index, item] of list.entries()) {
		const binding = parseOne(item, index);
		for (const seen of out) {
			if (seen.locator === binding.locator) {
				throw invalid(`binding[${index}]`, "locator is already bound");
			}
			if (seen.envName === binding.envName) {
				throw invalid(`binding[${index}]`, "env_name is already bound");
			}
		}
		out.push(binding);
	}
	return Object.freeze(out);
}
