// public-contract: the closed HTTP method vocabulary a resolver may issue.
import { isJsonNumber, isJsonString, type JsonValue } from "../json.js";

export const TRANSPORT_METHODS = Object.freeze([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
] as const);
export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

export interface TransportRequest {
	readonly method: TransportMethod;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
}

export interface TransportResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

export type HttpTransport = (
	request: TransportRequest,
) => Promise<TransportResponse>;

export interface TransportGuardPolicy {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefixes: readonly string[];
	readonly maxTimeoutMs: number;
	readonly maxResponseBytes: number;
	readonly allowedHostSuffixes?: readonly string[];
	readonly allowedPorts?: readonly string[];
}

// public-contract: every refusal a guarded transport can report.
export const TRANSPORT_GUARD_ERROR_CODES = Object.freeze([
	"TRANSPORT_SCHEME_FORBIDDEN",
	"TRANSPORT_HOST_FORBIDDEN",
	"TRANSPORT_PATH_FORBIDDEN",
	"TRANSPORT_TIMEOUT_EXCEEDED",
	"TRANSPORT_BODY_TOO_LARGE",
	"TRANSPORT_REDIRECT_REFUSED",
] as const);
export type TransportGuardErrorCode =
	(typeof TRANSPORT_GUARD_ERROR_CODES)[number];

export class TransportGuardError extends Error {
	readonly code: TransportGuardErrorCode;
	readonly detail: Readonly<Record<string, string>>;

	constructor(
		code: TransportGuardErrorCode,
		message: string,
		detail: Readonly<Record<string, string>> = {},
	) {
		super(message);
		this.name = "TransportGuardError";
		this.code = code;
		this.detail = Object.freeze({ ...detail });
	}
}

function boundedPeerText(value: string, max = 120): string {
	let clean = "";
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code < 32 || code === 127) continue;
		clean += ch;
	}
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function guardTransport(
	inner: HttpTransport,
	policy: TransportGuardPolicy,
): HttpTransport {
	return async (request: TransportRequest): Promise<TransportResponse> => {
		const url = assertAllowedEndpoint(request.url, policy);
		assertBoundedTimeout(request.timeoutMs, policy.maxTimeoutMs);
		const maxResponseBytes = assertBoundedResponseCap(
			request.maxResponseBytes,
			policy.maxResponseBytes,
		);

		const response = await inner({ ...request, url: url.toString() });

		assertNotRedirect(response);
		assertBoundedBody(response, maxResponseBytes);
		return response;
	};
}

function allowedPorts(policy: TransportGuardPolicy): readonly string[] {
	const declared = policy.allowedPorts ?? [];
	return declared.includes("443") ? declared : ["443", ...declared];
}

export function assertAllowedEndpoint(
	url: JsonValue,
	policy: TransportGuardPolicy,
): URL {
	if (!isJsonString(url) || url.trim().length === 0) {
		throw new TransportGuardError(
			"TRANSPORT_SCHEME_FORBIDDEN",
			"request url must be a non-empty https URL string",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new TransportGuardError(
			"TRANSPORT_SCHEME_FORBIDDEN",
			"request url is not a valid absolute URL",
		);
	}
	if (parsed.protocol !== "https:") {
		throw new TransportGuardError(
			"TRANSPORT_SCHEME_FORBIDDEN",
			`request url must use https, got ${parsed.protocol.replace(":", "")}`,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new TransportGuardError(
			"TRANSPORT_HOST_FORBIDDEN",
			"request url must not embed userinfo: credentials belong in headers a host injected, and userinfo hides the real host from a casual read",
		);
	}
	if (parsed.port !== "" && !allowedPorts(policy).includes(parsed.port)) {
		throw new TransportGuardError(
			"TRANSPORT_HOST_FORBIDDEN",
			`request url must use the default https port or one this policy allows (${allowedPorts(policy).join(", ")}), got ${parsed.port}`,
			{ port: parsed.port, allowed: allowedPorts(policy).join(",") },
		);
	}
	assertAllowedHost(parsed, policy);
	assertAllowedPath(parsed, policy);
	return parsed;
}

function assertUsableHostSuffixes(suffixes: readonly string[]): void {
	for (const suffix of suffixes) {
		const labels = suffix.split(".");
		const usable =
			labels.length >= 3 &&
			labels[0] === "" &&
			labels.slice(1).every((label) => label.length > 0);
		if (!usable) {
			throw new TransportGuardError(
				"TRANSPORT_HOST_FORBIDDEN",
				`policy allowedHostSuffixes entry ${JSON.stringify(suffix)} must start with "." and carry at least one further dot: "upstash.io" would also match evilupstash.io, and ".com" would match the registry`,
			);
		}
	}
}

function isUnderParentDomain(host: string, suffix: string): boolean {
	if (!host.endsWith(suffix)) return false;
	const child = host.slice(0, host.length - suffix.length);
	return child.length > 0 && !child.endsWith(".");
}

function assertAllowedHost(parsed: URL, policy: TransportGuardPolicy): void {
	const suffixes = policy.allowedHostSuffixes ?? [];
	assertUsableHostSuffixes(suffixes);
	const host = parsed.hostname;
	if (policy.allowedHosts.includes(host)) return;
	if (suffixes.some((suffix) => isUnderParentDomain(host, suffix))) return;
	const exact = `host ${host} is not exactly one of the allowlisted provider hosts (${policy.allowedHosts.join(", ") || "none"})`;
	throw new TransportGuardError(
		"TRANSPORT_HOST_FORBIDDEN",
		suffixes.length === 0
			? exact
			: `${exact} and is not under an allowlisted parent domain (${suffixes.join(", ")})`,
	);
}

export function encodesPathSeparator(pathname: string): boolean {
	return /%2e|%2f|%5c/iu.test(pathname);
}

function assertAllowedPath(parsed: URL, policy: TransportGuardPolicy): void {
	const path = parsed.pathname;
	if (encodesPathSeparator(path)) {
		throw new TransportGuardError(
			"TRANSPORT_PATH_FORBIDDEN",
			`path ${path} percent-encodes a path separator or dot segment, which this guard refuses rather than decodes: only the origin would resolve it, after every check here has passed`,
		);
	}
	if (!policy.allowedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
		throw new TransportGuardError(
			"TRANSPORT_PATH_FORBIDDEN",
			`path ${path} is outside the allowlisted prefixes (${policy.allowedPathPrefixes.join(", ") || "none"})`,
		);
	}
}

function assertBoundedTimeout(
	timeoutMs: JsonValue,
	maxTimeoutMs: number,
): void {
	if (
		!isJsonNumber(timeoutMs) ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		throw new TransportGuardError(
			"TRANSPORT_TIMEOUT_EXCEEDED",
			`request timeoutMs must be a positive finite number, received ${String(timeoutMs)}`,
		);
	}
	if (!Number.isFinite(maxTimeoutMs) || maxTimeoutMs <= 0) {
		throw new TransportGuardError(
			"TRANSPORT_TIMEOUT_EXCEEDED",
			`policy maxTimeoutMs must be a positive finite number, received ${String(maxTimeoutMs)}`,
		);
	}
	if (timeoutMs > maxTimeoutMs) {
		throw new TransportGuardError(
			"TRANSPORT_TIMEOUT_EXCEEDED",
			`request timeoutMs ${timeoutMs} exceeds the policy cap of ${maxTimeoutMs}`,
		);
	}
}

function assertBoundedResponseCap(
	maxResponseBytes: JsonValue,
	policyCap: number,
): number {
	if (
		!isJsonNumber(maxResponseBytes) ||
		!Number.isFinite(maxResponseBytes) ||
		maxResponseBytes <= 0
	) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`request maxResponseBytes must be a positive finite number, received ${String(maxResponseBytes)}`,
		);
	}
	if (!Number.isFinite(policyCap) || policyCap <= 0) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`policy maxResponseBytes must be a positive finite number, received ${String(policyCap)}`,
		);
	}
	if (maxResponseBytes > policyCap) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`request maxResponseBytes ${maxResponseBytes} exceeds the policy cap of ${policyCap}`,
		);
	}
	return maxResponseBytes;
}

function assertNotRedirect(response: TransportResponse): void {
	if (response.status < 300 || response.status >= 400) return;
	const location = headerValue(response.headers, "location");
	if (location === undefined) return;
	throw new TransportGuardError(
		"TRANSPORT_REDIRECT_REFUSED",
		`provider returned a ${response.status} redirect, which this transport never follows`,
		{ location: boundedPeerText(location) },
	);
}

function assertBoundedBody(
	response: TransportResponse,
	maxResponseBytes: number,
): void {
	const declared = Number(
		headerValue(response.headers, "content-length") ?? Number.NaN,
	);
	if (Number.isFinite(declared) && declared > maxResponseBytes) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`provider declared a ${declared} byte response, over the ${maxResponseBytes} byte cap`,
		);
	}
	if (utf8ByteLength(response.body) > maxResponseBytes) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`provider response exceeded the ${maxResponseBytes} byte cap`,
		);
	}
}

function headerValue(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}
