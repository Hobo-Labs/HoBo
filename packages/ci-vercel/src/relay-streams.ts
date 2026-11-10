/**
 * The paths of this host whose bodies are streamed. Sandbox forwarding carries
 * large package artifacts and bounded uploads; the proxy owns its own
 * streaming quota. Every other endpoint keeps the relay's 1 MiB body limit.
 */
export function streamsBody(pathname: string): boolean {
	return (
		pathname === "/sandbox/egress" ||
		pathname.startsWith("/sandbox/egress/") ||
		pathname === "/internal/sandbox/quota" ||
		pathname === "/internal/queue-wakeup"
	);
}
