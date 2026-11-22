import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { serveProjectOnHost } from "../src/multi-host-serve.js";

it("restores injected environment after startup fails with a private host running", async () => {
	const hoboHome = await mkdtemp(join(tmpdir(), "hobo-failed-host-env-"));
	const originalGreeting = process.env.GREETING_PREFIX;
	const originalTitle = process.env.APP_TITLE;
	const originalFetch = globalThis.fetch;
	try {
		process.env.GREETING_PREFIX = "previous-greeting";
		process.env.APP_TITLE = "previous-title";
		initBareMetalYard({ hoboHome, componentHost: "cloud-native" });
		await expect(
			serveProjectOnHost({
				projectDir: fileURLToPath(
					new URL("../../../examples/hello-bindle", import.meta.url),
				),
				hoboHome,
				port: 0,
				componentHost: "cloud-native",
				emitProgress(message) {
					if (message.startsWith("hobo dev: private ")) {
						process.env.APP_TITLE = "changed-during-startup";
						throw new Error("startup interrupted");
					}
				},
			}),
		).rejects.toThrow("startup interrupted");
		expect(process.env.GREETING_PREFIX).toBe("previous-greeting");
		expect(process.env.APP_TITLE).toBe("changed-during-startup");
		expect(globalThis.fetch).toBe(originalFetch);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalGreeting === undefined) delete process.env.GREETING_PREFIX;
		else process.env.GREETING_PREFIX = originalGreeting;
		if (originalTitle === undefined) delete process.env.APP_TITLE;
		else process.env.APP_TITLE = originalTitle;
		await rm(hoboHome, { recursive: true, force: true });
	}
});
