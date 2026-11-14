/**
 * The overlay transport identity: `overlay:<SEAL key>@<host>:<port>`, where
 * the SEAL key is the device's raw X25519 key (base64url, no padding) and
 * `host:port` is where it accepts on the overlay (an IPv6 host is bracketed).
 *
 * The SEAL key part is proven by the session handshake and the host part by
 * the overlay itself (WireGuard authenticates the source address), so an
 * acceptor reports a dialler's identity only when both match the connection.
 */
import { isIPv4, isIPv6 } from "node:net";

// public-contract: prefix of an overlay FleetTransport identity, carried in session grants.
export const OVERLAY_IDENTITY_PREFIX = "overlay:";
/** A raw 32-byte X25519 key, base64url without padding. */
const RAW_X25519 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const IDENTITY =
	/^overlay:([^@]+)@(?:\[([0-9A-Fa-f:.]+)\]|([0-9.]+)):(\d{1,5})$/u;

export type OverlayAddress = Readonly<{
	sealPublicKey: string;
	host: string;
	port: number;
}>;

/** The form a socket reports an IPv4 peer in on a dual-stack listener is `::ffff:a.b.c.d`. */
export function normaliseHost(address: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
	return (mapped?.[1] ?? address).toLowerCase();
}

export function formatOverlayIdentity(address: OverlayAddress): string {
	const host = isIPv6(address.host) ? `[${address.host}]` : address.host;
	return `${OVERLAY_IDENTITY_PREFIX}${address.sealPublicKey}@${host}:${address.port}`;
}

export function parseOverlayIdentity(
	identity: string,
): OverlayAddress | undefined {
	const match = IDENTITY.exec(identity);
	if (match === null) return undefined;
	const [, seal = "", v6, v4, portText = ""] = match;
	const host = v6 ?? v4 ?? "";
	const port = Number(portText);
	if (!RAW_X25519.test(seal)) return undefined;
	if (v6 !== undefined ? !isIPv6(host) : !isIPv4(host)) return undefined;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return { sealPublicKey: seal, host: normaliseHost(host), port };
}

/** The address this device accepts on: its first IPv4 overlay address, else its first IPv6 one. */
export function overlayHost(overlayIps: readonly string[]): string | undefined {
	const usable = overlayIps.map(normaliseHost);
	return usable.find((ip) => isIPv4(ip)) ?? usable.find((ip) => isIPv6(ip));
}
