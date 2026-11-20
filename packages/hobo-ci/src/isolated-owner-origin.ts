export const OWNER_PROXY_CONNECTION_LIMIT = 32;

export function isolatedOwnerOrigin(
	input: string,
	allowInsecureLoopback: boolean,
	usingProxy: boolean,
): string {
	const url = new URL(input);
	if (url.protocol === "https:") return url.origin;
	if (
		url.protocol === "http:" &&
		allowInsecureLoopback &&
		!usingProxy &&
		(url.hostname === "127.0.0.1" || url.hostname === "[::1]")
	)
		return url.origin;
	throw new Error("Private owner transport requires HTTPS.");
}

export function assertPrivateOwnerProxy(proxy: string | undefined): void {
	if (proxy === undefined) return;
	const url = new URL(proxy);
	if (url.protocol !== "https:" && (url.username !== "" || url.password !== ""))
		throw new Error("Authenticated private owner proxies require HTTPS.");
}
