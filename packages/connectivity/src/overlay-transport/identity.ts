import { isIPv4, isIPv6 } from "node:net";

// public-contract: prefix of an overlay FleetTransport identity, carried in session grants.
export const OVERLAY_IDENTITY_PREFIX = "overlay:";
const RAW_X25519 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const IDENTITY =
	/^overlay:([^@]+)@(?:\[([0-9A-Fa-f:.]+)\]|([0-9.]+)):(\d{1,5})$/u;

export type OverlayAddress = Readonly<{
	sealPublicKey: string;
	host: string;
	port: number;
}>;

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

export function overlayHost(overlayIps: readonly string[]): string | undefined {
	const usable = overlayIps.map(normaliseHost);
	return usable.find((ip) => isIPv4(ip)) ?? usable.find((ip) => isIPv6(ip));
}
