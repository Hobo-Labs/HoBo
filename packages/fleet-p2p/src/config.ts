/**
 * The transport's one setting, parsed (data-models/fleet_p2p.cue): the relays
 * HoBo runs. A relay is `https://`, or plain `http://` on a loopback address,
 * which is how a relay in development mode (and the integration lane's) is
 * served. No credentials in the URL, no duplicates. The public relays are
 * never added: an empty list means no relaying at all.
 */
import { FleetParseError } from "@hobo/fleet";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseRelayUrl(value: string, field: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new FleetParseError(field, `${field} is not a URL`);
	}
	const secure = url.protocol === "https:";
	const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
	if (!secure && !loopback)
		throw new FleetParseError(
			field,
			`${field} must be https://, or http:// on a loopback address`,
		);
	if (url.username !== "" || url.password !== "")
		throw new FleetParseError(field, `${field} must not carry credentials`);
	return url.href;
}

/** Relay URLs, each normalised by the URL parser; throws `FleetParseError` on the first bad one. */
export function parseRelayUrls(values: readonly string[]): readonly string[] {
	const parsed: string[] = [];
	values.forEach((value, index) => {
		const field = `relayUrls[${index}]`;
		const url = parseRelayUrl(value, field);
		if (parsed.includes(url))
			throw new FleetParseError(field, `${field} repeats ${url}`);
		parsed.push(url);
	});
	return Object.freeze(parsed);
}
