import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { serveProjectOnBareMetalYard } from "../src/bare-metal-host.js";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { isJsonString } from "../src/json.js";
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

it.each(paths)("cleans up $name when a listener cannot start", async ({
	serve,
}) => {
	const hoboHome = await mkdtemp(join(tmpdir(), "hobo-host-failure-"));
	const blocker = createServer();
	const originalFetch = globalThis.fetch;
	const keys = [
		"GREETING_PREFIX",
		"APP_TITLE",
		"services__api__http__0",
		"services__web__http__0",
	];
	const original = new Map(keys.map((key) => [key, process.env[key]]));
	try {
		process.env.GREETING_PREFIX = "previous-greeting";
		process.env.services__api__http__0 = "previous-api";
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(0, "127.0.0.1", resolve);
		});
		const address = blocker.address();
		if (address === null || isJsonString(address))
			throw new Error("missing listener port");
		initBareMetalYard({ hoboHome, componentHost: "cloud-native" });
		await expect(
			serve({
				projectDir: fileURLToPath(
					new URL("../../../examples/hello-bindle", import.meta.url),
				),
				hoboHome,
				port: address.port,
			}),
		).rejects.toThrow(/EADDRINUSE/);
		expect(globalThis.fetch).toBe(originalFetch);
		expect(process.env.GREETING_PREFIX).toBe("previous-greeting");
		expect(process.env.services__api__http__0).toBe("previous-api");
		expect(process.env.services__web__http__0).toBe(
			original.get("services__web__http__0"),
		);
	} finally {
		globalThis.fetch = originalFetch;
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		for (const [key, value] of original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(hoboHome, { recursive: true, force: true });
	}
});
