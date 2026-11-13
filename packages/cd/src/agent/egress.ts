// Agent egress (promoted from `hobo-relay-contract`: outbound-only, SSRF and
// deny-by-default rules). An agent talks to exactly one origin — its
// Station's delivery feed — over HTTPS, under `/v1/cd/` only:
//
//   - the base URL must be `https:` with no userinfo, query or fragment;
//   - metadata endpoints (169.254.169.254, fd00:ec2::254,
//     metadata.google.internal) and link-local / unspecified literals are
//     refused even when configured;
//   - every request goes through `@hobo/core` `guardTransport` with that one
//     host and the `/v1/cd/` prefix: no redirects, bounded body and time,
//     percent-encoded separators refused;
//   - nothing listens: the agent has no inbound surface (relay proof: no
//     inbound listeners), and the Station never dials the agent (I3).
import {
	guardTransport,
	type HttpTransport,
	TransportGuardError,
	type TransportGuardPolicy,
} from "@hobo/core";
import { AGENT_FAILURES } from "./errors.js";

// public-contract: hosts an agent never dials.
export const METADATA_HOSTS: ReadonlySet<string> = new Set([
	"169.254.169.254",
	"[fd00:ec2::254]",
	"fd00:ec2::254",
	"metadata.google.internal",
]);

// public-contract: response cap of one feed response at the agent.
export const AGENT_MAX_RESPONSE_BYTES = 16_777_216 as const;
// public-contract: longest agent request (long-poll plus margin).
export const AGENT_MAX_TIMEOUT_MS = 120_000 as const;

export class AgentEgressError extends Error {
	readonly code = "egress-refused" as const;
	readonly remediation = AGENT_FAILURES["egress-refused"].remediation;
	constructor(message: string) {
		super(message);
		this.name = "AgentEgressError";
	}
}

declare const stationOriginBrand: unique symbol;
/** A parsed, egress-safe Station origin (`https://host[:port]`). */
export type StationOrigin = Readonly<{
	origin: string;
	host: string;
	port: string;
}> & { readonly [stationOriginBrand]: "cd.StationOrigin" };

function linkLocalOrUnspecified(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	return (
		h.startsWith("169.254.") ||
		h === "0.0.0.0" ||
		h === "::" ||
		h.startsWith("fe80:") ||
		h === "metadata"
	);
}

/** Parse the configured Station base URL or refuse it. */
export function parseStationOrigin(baseUrl: string): StationOrigin {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new AgentEgressError(
			`station base URL ${JSON.stringify(baseUrl)} does not parse`,
		);
	}
	if (url.protocol !== "https:")
		throw new AgentEgressError("agent egress is HTTPS only");
	if (url.username || url.password)
		throw new AgentEgressError(
			"the station base URL must not carry credentials",
		);
	if (url.search || url.hash)
		throw new AgentEgressError(
			"the station base URL must not carry a query or fragment",
		);
	if (url.pathname !== "/" && url.pathname !== "")
		throw new AgentEgressError(
			"the station base URL is an origin; the agent adds /v1/cd/",
		);
	if (
		METADATA_HOSTS.has(url.hostname.toLowerCase()) ||
		linkLocalOrUnspecified(url.hostname)
	)
		throw new AgentEgressError(
			`${url.hostname} is a metadata or link-local endpoint`,
		);
	// SAFETY: every rule above held.
	return Object.freeze({
		origin: url.origin,
		host: url.hostname,
		port: url.port || "443",
	}) as StationOrigin;
}

/** The only transport an agent uses: guarded to its Station's delivery feed. */
export function stationTransport(
	origin: StationOrigin,
	http: HttpTransport,
): HttpTransport {
	const policy: TransportGuardPolicy = {
		allowedHosts: [origin.host],
		allowedPathPrefixes: ["/v1/cd/"],
		maxTimeoutMs: AGENT_MAX_TIMEOUT_MS,
		maxResponseBytes: AGENT_MAX_RESPONSE_BYTES,
		allowedPorts: [origin.port],
	};
	return guardTransport(http, policy);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only the guard error class is read.
export function isEgressRefusal(error: unknown): boolean {
	return (
		error instanceof AgentEgressError || error instanceof TransportGuardError
	);
}
