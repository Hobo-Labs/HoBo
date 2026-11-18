import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { serveProjectOnBareMetalYard } from "../src/bare-metal-host.js";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { serveBindleOnLocalYard } from "../src/local-yard-serve.js";
import { serveProjectOnHost } from "../src/multi-host-serve.js";

const paths = [
	{ name: "bare-metal", serve: serveProjectOnBareMetalYard },
	{ name: "local component host", serve: serveBindleOnLocalYard },
	{
		name: "multi-host",
		serve: (options: { projectDir: string; hoboHome: string; port: number }) =>
			serveProjectOnHost({ ...options, componentHost: "cloud-native" }),
	},
];

it.each(paths)("restores prior environment when $name closes", async ({
	serve,
}) => {
	const hoboHome = await mkdtemp(join(tmpdir(), "hobo-host-env-"));
	const keys = [
		"GREETING_PREFIX",
		"APP_TITLE",
		"services__api__http__0",
		"HOBO_NAMED_API_URL",
	];
	const original = new Map(keys.map((key) => [key, process.env[key]]));
	let running: Awaited<ReturnType<typeof serve>> | undefined;
	try {
		process.env.GREETING_PREFIX = "previous-greeting";
		process.env.APP_TITLE = "previous-title";
		process.env.services__api__http__0 = "previous-api";
		process.env.HOBO_NAMED_API_URL = "previous-named-api";
		initBareMetalYard({ hoboHome, componentHost: "cloud-native" });
		running = await serve({
			projectDir: fileURLToPath(
				new URL("../../../examples/hello-bindle", import.meta.url),
			),
			hoboHome,
			port: 0,
		});
		expect(process.env.GREETING_PREFIX).toBe("howdy");
		expect(running.primaryUrl).not.toMatch(/:0(?:\/|$)/);
		expect((await fetch(running.primaryUrl)).status).toBe(200);
		process.env.APP_TITLE = "changed-while-running";
		await running.close();
		running = undefined;
		expect(process.env.GREETING_PREFIX).toBe("previous-greeting");
		expect(process.env.APP_TITLE).toBe("changed-while-running");
		expect(process.env.services__api__http__0).toBe("previous-api");
		expect(process.env.HOBO_NAMED_API_URL).toBe("previous-named-api");
	} finally {
		await running?.close();
		for (const [key, value] of original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(hoboHome, { recursive: true, force: true });
	}
});
