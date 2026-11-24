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
