/**
 * The one parser boundary of @hobo/provider-webernetes.
 *
 * Two kinds of untrusted value reach this package: deploy plans handed in by
 * the yard placement plane, and whatever the injected `LocalTempTransport`
 * says it stood up. Both cross a parser here and come out as refined domain
 * types. Nothing downstream re-checks a port, re-sanitizes a name, or re-reads
 * a URL string — `WebernetesLocalEndpoint` already knows its scheme, host, and
 * locality because the parser established them once.
 *
 * `data-models/provider_webernetes.proto` is the wire view of these shapes and
 * `data-models/provider_webernetes.cue` carries the invariants enforced below.
 */

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type { JsonObject, JsonValue } from "./json.js";

export type WebernetesPortKind = "compute" | "kv" | "queue";

/** Every port the equivalence table actually claims. */
export const WEBERNETES_PORTS = Object.freeze([
	"compute",
	"kv",
	"queue",
]) satisfies readonly WebernetesPortKind[];

export type WebernetesFeature = string & {
	readonly __webernetesFeature: unique symbol;
};

/** A name safe to become a DNS label in a local named endpoint (ADR-0130). */
export type WebernetesResourceName = string & {
	readonly __webernetesResourceName: unique symbol;
};

// domain-view: richer than the wire form on purpose — `name` is a branded DNS label and `port` is the closed union the equivalence table supports, so an unhostable plan is unrepresentable rather than merely invalid. No buf codegen is wired for this package, so data-models/provider_webernetes.proto is the design-time view of this record.
export type WebernetesResourcePlan = {
	readonly name: WebernetesResourceName;
	readonly port: WebernetesPortKind;
	readonly require: readonly WebernetesFeature[];
	readonly prefer: readonly WebernetesFeature[];
};

export type WebernetesBindings = Readonly<Record<string, string>>;

/**
 * Where an endpoint lives. This is the whole point of parsing a station URL:
 * a public host would mean the transport deployed somewhere that needs an
 * account, and the anonymous claim would be false.
 */
export type WebernetesEndpointLocality =
	| "loopback"
	| "private-network"
	| "overlay";

// domain-view: richer than the wire form — `locality` is a closed union the parser establishes once, so no later code re-parses the URL string to ask where the station lives. No buf codegen is wired here, so data-models/provider_webernetes.proto is the design-time view of this record.
export type WebernetesLocalEndpoint = {
	readonly url: string;
	readonly scheme: "http" | "https";
	readonly host: string;
	readonly locality: WebernetesEndpointLocality;
};

// public-contract: stable parser error code exposed to callers.
export const WEBERNETES_REJECTED_CODE =
	"HOBO_WEBERNETES_INPUT_REJECTED" as const;

export class WebernetesInputRejectedError extends Error {
	readonly code = WEBERNETES_REJECTED_CODE;
	readonly field: string;

	constructor(field: string, reason: string) {
		super(`webernetes rejected ${field}: ${reason}`);
		this.name = "WebernetesInputRejectedError";
		this.field = field;
	}
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;
const FEATURE = /^[a-z][a-z0-9-]*$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_BINDING_LENGTH = 2048;

function isPrintableLine(value: string): boolean {
	return value.length <= MAX_BINDING_LENGTH && !CONTROL_CHARACTER.test(value);
}
const BINDING_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const STATION_ID = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function record(value: JsonValue, field: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new WebernetesInputRejectedError(field, "expected an object");
	}
	return value;
}

function isWebernetesPort(value: string): value is WebernetesPortKind {
	switch (value) {
		case "compute":
		case "kv":
		case "queue":
			return true;
		default:
			return false;
	}
}

export function webernetesPortOrUndefined(
	value: JsonValue | undefined,
): WebernetesPortKind | undefined {
	return isJsonString(value) && isWebernetesPort(value) ? value : undefined;
}

export function parseWebernetesPort(
	value: JsonValue | undefined,
	field = "port",
): WebernetesPortKind {
	const port = webernetesPortOrUndefined(value);
	if (port === undefined) {
		throw new WebernetesInputRejectedError(
			field,
			`webernetes hosts ${WEBERNETES_PORTS.join(", ")}, not ${JSON.stringify(value)}`,
		);
	}
	return port;
}

export function parseWebernetesResourceName(
	value: JsonValue | undefined,
	field = "name",
): WebernetesResourceName {
	if (!isJsonString(value) || !DNS_LABEL.test(value)) {
		throw new WebernetesInputRejectedError(
			field,
			"expected a DNS label (lowercase alphanumeric and hyphens, 1-63 chars)",
		);
	}
	// SAFETY: DNS_LABEL is the WebernetesResourceName contract at this parse boundary.
	return value as WebernetesResourceName;
}

function parseFeatures(
	value: JsonValue | undefined,
	field: string,
): readonly WebernetesFeature[] {
	if (value === undefined) return Object.freeze([]);
	if (!isJsonArray(value)) {
		throw new WebernetesInputRejectedError(
			field,
			"expected an array of features",
		);
	}
	const features: WebernetesFeature[] = [];
	for (const entry of value) {
		if (!isJsonString(entry) || !FEATURE.test(entry)) {
			throw new WebernetesInputRejectedError(
				field,
				`feature names are lowercase and hyphenated; got ${JSON.stringify(entry)}`,
			);
		}
		// SAFETY: FEATURE is the WebernetesFeature contract at this parse boundary.
		features.push(entry as WebernetesFeature);
	}
	return Object.freeze(features);
}

export function parseWebernetesResourcePlan(
	value: JsonValue,
): WebernetesResourcePlan {
	const raw = record(value, "plan");
	return Object.freeze({
		name: parseWebernetesResourceName(raw.name),
		port: parseWebernetesPort(raw.port),
		require: parseFeatures(raw.require, "plan.require"),
		prefer: parseFeatures(raw.prefer, "plan.prefer"),
	});
}

export function parseWebernetesBindings(value: JsonValue): WebernetesBindings {
	const raw = record(value, "bindings");
	const parsed: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (!BINDING_KEY.test(key)) {
			throw new WebernetesInputRejectedError(
				"bindings",
				`binding key ${JSON.stringify(key)} is not an identifier`,
			);
		}
		if (!isJsonString(entry) || !isPrintableLine(entry)) {
			throw new WebernetesInputRejectedError(
				`bindings.${key}`,
				"expected a printable single-line string of at most 2048 characters",
			);
		}
		parsed[key] = entry;
	}
	return Object.freeze(parsed);
}

export function parseWebernetesStationId(value: JsonValue | undefined): string {
	if (!isJsonString(value) || !STATION_ID.test(value)) {
		throw new WebernetesInputRejectedError(
			"stationId",
			"expected an opaque id of at most 128 characters from [A-Za-z0-9._:-] starting alphanumeric",
		);
	}
	return value;
}

function isLoopbackIpv4(host: string): boolean {
	const match = IPV4.exec(host);
	return match?.[1] === "127";
}

function isPrivateIpv4(host: string): boolean {
	const match = IPV4.exec(host);
	if (!match) return false;
	const octets = match.slice(1, 5).map((part) => Number(part));
	if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
	const first = octets[0];
	const second = octets[1];
	if (first === undefined || second === undefined) return false;
	if (first === 10) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	return first === 192 && second === 168;
}

/**
 * Locality is the honest question about a station URL. A dev server answers on
 * loopback or on a LAN address; the overlay answers on a `.hobo.test` name
 * (ADR-0130). Anything else — a `github.io`, a `vercel.app`, a bare `.hobo` —
 * is not a local station, whatever the transport called it.
 */
function localityOf(host: string): WebernetesEndpointLocality | undefined {
	if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
	if (host === "[::1]" || isLoopbackIpv4(host)) return "loopback";
	if (host.endsWith(".hobo.test")) return "overlay";
	if (isPrivateIpv4(host)) return "private-network";
	return undefined;
}

export function parseWebernetesLocalEndpoint(
	value: JsonValue | undefined,
	field: string,
): WebernetesLocalEndpoint {
	if (!isJsonString(value) || value.length === 0) {
		throw new WebernetesInputRejectedError(field, "expected an absolute URL");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebernetesInputRejectedError(
			field,
			`not an absolute URL: ${JSON.stringify(value)}`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebernetesInputRejectedError(
			field,
			`expected http or https, got ${url.protocol.replace(":", "")}`,
		);
	}
	// Userinfo in a station URL is a credential travelling in a locator, which
	// is exactly what the secretless rules forbid (ADR-0027).
	if (url.username !== "" || url.password !== "") {
		throw new WebernetesInputRejectedError(
			field,
			"station URLs carry no userinfo",
		);
	}
	const locality = localityOf(url.hostname);
	if (locality === undefined) {
		throw new WebernetesInputRejectedError(
			field,
			`${url.hostname} is not a local station host; webernetes stands up loopback, RFC1918, or .hobo.test endpoints only`,
		);
	}
	return Object.freeze({
		url: value,
		scheme: url.protocol === "https:" ? "https" : "http",
		host: url.hostname,
		locality,
	});
}

// domain-view: the transport's raw reply, kept as its own type so the untrusted and parsed halves of the station boundary cannot be confused. No buf codegen is wired here, so data-models/provider_webernetes.proto is the design-time view of this record.
export type WebernetesStationDeployment = {
	readonly station: WebernetesLocalEndpoint;
	readonly claim: WebernetesLocalEndpoint;
};

/**
 * Everything the injected transport says it stood up crosses here. After this
 * call, "the station is local and carries no credential in its URL" is a
 * property of the type rather than a hope about the transport.
 */
export function parseWebernetesStationDeployment(
	value: JsonValue,
): WebernetesStationDeployment {
	const raw = record(value, "deployment");
	return Object.freeze({
		station: parseWebernetesLocalEndpoint(raw.stationUrl, "stationUrl"),
		claim: parseWebernetesLocalEndpoint(raw.claimUrl, "claimUrl"),
	});
}
