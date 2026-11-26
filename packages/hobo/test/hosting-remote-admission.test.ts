import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { createBrokerAwareUpCommand } from "../src/broker-up-command.js";
import { createDefaultYardRuntime } from "../src/compose.js";

it("cannot bypass a production runtime's budget requirement through anonymous remote placement or a missing manifest", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "hosting-remote-gate-"));
	const runtime = createDefaultYardRuntime({
		env: { VERCEL_TOKEN: "fixture-credential" },
	});
	let calls = 0;
	try {
		const command = createBrokerAwareUpCommand({
			runtime,
			createRemoteClient: () => {
				calls += 1;
				throw new Error("remote placement must not run");
			},
		});
		const request = parseArgv(
			["up", "--broker", "https://public.example.com", "--anonymous"],
			{ cwd },
		);
		const result = await command.run({
			context: {
				cwd,
				projectDir: cwd,
				identity: null,
				clients: { readApi: "local", runtime: "local" },
			},
			flags: request.flags,
			args: request.args,
			verb: "up",
			emitProgress: () => {},
		});
		expect(result.code).toBe("HOBO_HOSTING_AUTHORITY_REQUIRED");
		expect(calls).toBe(0);
	} finally {
		// SAFETY: this constructor creates the concrete runtime-local SQLite store.
		(runtime.store as RuntimeLocalEventStore).close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
