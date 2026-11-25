export function streamsBody(pathname: string): boolean {
	return (
		pathname === "/sandbox/egress" ||
		pathname.startsWith("/sandbox/egress/") ||
		pathname === "/internal/sandbox/quota" ||
		pathname === "/internal/queue-wakeup"
	);
}
