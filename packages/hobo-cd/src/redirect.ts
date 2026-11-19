export function parseVercelRedirect(value: string): URL | undefined {
	if (!URL.canParse(value)) return undefined;
	const url = new URL(value);
	return url.protocol === "http:" &&
		url.hostname === "127.0.0.1" &&
		url.port !== ""
		? url
		: undefined;
}
