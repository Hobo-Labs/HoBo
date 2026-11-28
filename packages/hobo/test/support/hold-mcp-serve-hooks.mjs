// Module hooks for hold-mcp-serve.mjs. mcp-serve is replaced by a stand-in
// that waits for SIGUSR2 with a top-level await, then loads the real module.
// A hook that itself waited would block the main thread on Node 24, and
// with it the very answer the test checks for; a top-level await does not.
const RELEASED = "hold=released";

export async function load(url, context, nextLoad) {
	const { pathname } = new URL(url);
	if (!/\/mcp-serve\.(js|ts)$/u.test(pathname) || url.includes(RELEASED))
		return nextLoad(url, context);
	const real = `${url}${url.includes("?") ? "&" : "?"}${RELEASED}`;
	return {
		format: "module",
		shortCircuit: true,
		source: [
			'await (globalThis[Symbol.for("hobo.test.holdMcpServeRelease")] ?? new Promise((resolve) => process.once("SIGUSR2", resolve)));',
			`const real = await import(${JSON.stringify(real)});`,
			"export const serveHoboMcpOn = real.serveHoboMcpOn;",
			"export const runHoboMcp = real.runHoboMcp;",
		].join("\n"),
	};
}
