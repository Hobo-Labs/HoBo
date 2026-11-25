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
			'await new Promise((resolve) => process.once("SIGUSR2", resolve));',
			`const real = await import(${JSON.stringify(real)});`,
			"export const serveHoboMcpOn = real.serveHoboMcpOn;",
			"export const runHoboMcp = real.runHoboMcp;",
		].join("\n"),
	};
}
