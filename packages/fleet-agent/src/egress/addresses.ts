/**
 * Addresses the egress proxy never connects to, whatever an allowlist says
 * (design §6.11 "Egress"): cloud metadata and link-local addresses, plus
 * loopback, unspecified and multicast ones, so that a sandbox cannot reach
 * the agent's own host services through its proxy either.
 */
import { isIPv4, isIPv6 } from "node:net";

export type RefusalReason =
	| "metadata"
	| "link-local"
	| "loopback"
	| "unspecified"
	| "multicast";

/** Cloud metadata addresses that are not link-local (Alibaba, AWS over IPv6). */
const METADATA_V4 = new Set(["169.254.169.254", "100.100.100.200"]);
const METADATA_V6 = "fd00:ec2:0:0:0:0:0:254";

/** Host names that only ever name a metadata service. */
const METADATA_NAMES = new Set([
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
	"instance-data",
	"instance-data.ec2.internal",
]);

/** Lower case, without a trailing dot or IPv6 brackets. */
export function normaliseHost(host: string): string {
	const trimmed = host.trim().toLowerCase();
	const unbracketed =
		trimmed.startsWith("[") && trimmed.endsWith("]")
			? trimmed.slice(1, -1)
			: trimmed;
	return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

/** Why a host name is refused before any lookup, or undefined. */
export function refusedName(host: string): RefusalReason | undefined {
	const name = normaliseHost(host);
	if (METADATA_NAMES.has(name)) return "metadata";
	if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
	return isIPv4(name) || isIPv6(name) ? refusedAddress(name) : undefined;
}

/** Why an IP address is refused, or undefined when the proxy may connect to it. */
export function refusedAddress(address: string): RefusalReason | undefined {
	const normal = normaliseHost(address);
	if (isIPv4(normal)) return refusedV4(normal);
	if (isIPv6(normal)) return refusedV6(normal);
	// Not an address at all: refuse rather than guess.
	return "unspecified";
}

function refusedV4(address: string): RefusalReason | undefined {
	const octets = address.split(".").map(Number);
	const [a = 0, b = 0] = octets;
	if (METADATA_V4.has(address)) return "metadata";
	if (a === 169 && b === 254) return "link-local";
	if (a === 127) return "loopback";
	if (a === 0) return "unspecified";
	if (a >= 224) return "multicast";
	return undefined;
}

/** Eight 16-bit groups of an IPv6 address, `::` expanded and an embedded IPv4 tail converted. */
function groupsOf(address: string): number[] {
	let text = address;
	const tail = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)?.[1];
	if (tail !== undefined) {
		const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
		text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", rest] = text.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = rest === undefined || rest === "" ? [] : rest.split(":");
	const missing = rest === undefined ? 0 : 8 - left.length - right.length;
	return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) =>
		Number.parseInt(group, 16),
	);
}

function refusedV6(address: string): RefusalReason | undefined {
	const groups = groupsOf(address);
	const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
		groups;
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms carry an IPv4 address.
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
		if (g5 === 0xffff || (g5 === 0 && (g6 !== 0 || g7 > 1)))
			return refusedV4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
		if (g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
		if (g5 === 0 && g6 === 0 && g7 === 0) return "unspecified";
	}
	if (groups.map((group) => group.toString(16)).join(":") === METADATA_V6)
		return "metadata";
	if ((g0 & 0xffc0) === 0xfe80) return "link-local";
	if ((g0 & 0xff00) === 0xff00) return "multicast";
	return undefined;
}
