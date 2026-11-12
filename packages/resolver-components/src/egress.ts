// Host-mediated egress for resolver components: the declared allowlist plus
// the Relay proof's SSRF rules (src/draft/technical-proofs/hobo-relay-contract):
//   - no forward proxy: only a registered host, port and path prefix;
//   - never a metadata endpoint, by name or by address;
//   - no IP literals: an allowlist names hosts;
//   - no rebinding: every resolved address is checked, and a private,
//     loopback, link-local or reserved address is refused unless the
//     component runs in agent mode and the address is in that host's local
//     allowlist (then every address must be in it);
//   - no redirects (checked on the response by the caller).
// Pure apart from the injected resolver; no clock, no randomness.
import { BlockList, isIP } from "node:net";
import { encodesPathSeparator } from "@hobo/core";
import { EgressDenialCode } from "./_generated/resolver_components_pb.js";
import type {
	ComponentEgressHost,
	ComponentManifest,
	ReconcilerMode,
} from "./manifest.js";

/** Resolve a host name to its addresses (A/AAAA). Injected, never ambient. */
export type AddressResolver = (host: string) => Promise<readonly string[]>;

export interface EgressPolicy {
	readonly manifest: ComponentManifest;
	readonly mode: ReconcilerMode;
	readonly resolveHost: AddressResolver;
}

// domain-view: parsed derived type; wire form is EgressDenialRecord.
export interface EgressDenial {
	readonly code: EgressDenialCode;
	readonly host: string;
	readonly detail: string;
}

export type EgressVerdict =
	| {
			readonly ok: true;
			readonly url: URL;
			readonly entry: ComponentEgressHost;
			readonly addresses: readonly string[];
	  }
	| { readonly ok: false; readonly denial: EgressDenial };

// public-contract: metadata endpoints refused by name or address (relay proof).
export const METADATA_ENDPOINTS = Object.freeze([
	"169.254.169.254",
	"169.254.170.2",
	"fd00:ec2::254",
	"100.100.100.200",
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
	"instance-data",
	"instance-data.ec2.internal",
]);

const PRIVATE_V4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	PRIVATE_V4.addSubnet(network, prefix, "ipv4");
}
const PRIVATE_V6 = new BlockList();
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["100::", 64],
	["2001:db8::", 32],
	["2001::", 23],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) {
	PRIVATE_V6.addSubnet(network, prefix, "ipv6");
}

/** True for any address a component must not reach outside agent mode. */
export function isPrivateAddress(address: string): boolean {
	const bare = stripBrackets(address).toLowerCase();
	const family = isIP(bare);
	if (family === 4) return PRIVATE_V4.check(bare, "ipv4");
	if (family !== 6) return true; // unparseable: fail closed
	const embedded = embeddedV4(bare);
	if (embedded !== undefined) return PRIVATE_V4.check(embedded, "ipv4");
	return PRIVATE_V6.check(bare, "ipv6");
}

/** IPv4 carried in an IPv4-mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96) address. */
function embeddedV4(address: string): string | undefined {
	const mapped = /^::ffff:(?:0:)?(.+)$/u.exec(address);
	const nat64 = /^64:ff9b::(.+)$/u.exec(address);
	const tail = mapped?.[1] ?? nat64?.[1];
	if (tail === undefined) return undefined;
	if (isIP(tail) === 4) return tail;
	const groups = tail.split(":");
	if (groups.length !== 2) return undefined;
	const high = Number.parseInt(groups[0] ?? "", 16);
	const low = Number.parseInt(groups[1] ?? "", 16);
	if (Number.isNaN(high) || Number.isNaN(low)) return undefined;
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function isMetadata(hostOrAddress: string): boolean {
	return METADATA_ENDPOINTS.includes(stripBrackets(hostOrAddress).toLowerCase());
}

function stripBrackets(value: string): string {
	return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function deny(code: EgressDenialCode, host: string, detail: string): EgressVerdict {
	return { ok: false, denial: Object.freeze({ code, host, detail }) };
}

/** Decide one outbound request. Never throws for a hostile URL. */
export async function checkEgress(
	rawUrl: string,
	policy: EgressPolicy,
): Promise<EgressVerdict> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return deny(EgressDenialCode.SCHEME_FORBIDDEN, "", "request url is not an absolute URL");
	}
	const host = stripBrackets(url.hostname);
	if (url.protocol !== "https:")
		return deny(EgressDenialCode.SCHEME_FORBIDDEN, host, `scheme ${url.protocol} is not https`);
	if (url.username !== "" || url.password !== "")
		return deny(
			EgressDenialCode.HOST_NOT_ALLOWLISTED,
			host,
			"userinfo hides the real host; credentials are attached by the host only",
		);
	if (isMetadata(host))
		return deny(EgressDenialCode.METADATA_ENDPOINT, host, `${host} is a metadata endpoint`);
	if (isIP(host) !== 0)
		return deny(
			EgressDenialCode.HOST_NOT_ALLOWLISTED,
			host,
			"IP literals are never allowlisted; name the host in the manifest",
		);
	const entry = policy.manifest.egress.find((candidate) => candidate.host === host);
	if (entry === undefined)
		return deny(
			EgressDenialCode.HOST_NOT_ALLOWLISTED,
			host,
			`${host} is not in the signed egress allowlist`,
		);
	if (url.port !== "" && url.port !== "443" && !entry.ports.includes(url.port))
		return deny(EgressDenialCode.PORT_FORBIDDEN, host, `port ${url.port} is not registered for ${host}`);
	if (
		encodesPathSeparator(url.pathname) ||
		!entry.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix))
	)
		return deny(
			EgressDenialCode.PATH_FORBIDDEN,
			host,
			`path ${url.pathname} is outside ${entry.pathPrefixes.join(", ")}`,
		);
	return resolveChecked(url, entry, policy);
}

async function resolveChecked(
	url: URL,
	entry: ComponentEgressHost,
	policy: EgressPolicy,
): Promise<EgressVerdict> {
	const host = entry.host;
	let addresses: readonly string[];
	try {
		addresses = [...(await policy.resolveHost(host))].sort();
	} catch {
		addresses = [];
	}
	if (addresses.length === 0)
		return deny(EgressDenialCode.REBINDING, host, `${host} did not resolve`);
	const localAllowed = policy.mode === "agent" && entry.localAddresses.length > 0;
	for (const address of addresses) {
		if (isMetadata(address))
			return deny(EgressDenialCode.METADATA_ENDPOINT, host, `${host} resolved to a metadata endpoint`);
		if (localAllowed) {
			if (!entry.localAddresses.includes(address))
				return deny(
					EgressDenialCode.REBINDING,
					host,
					`${host} resolved to ${address}, outside its registered local addresses`,
				);
			continue;
		}
		if (isPrivateAddress(address))
			return deny(
				EgressDenialCode.PRIVATE_ADDRESS,
				host,
				`${host} resolved to private address ${address}`,
			);
	}
	return { ok: true, url, entry, addresses: Object.freeze(addresses) };
}
