import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTest } from "rivetkit/test";
import { describe, expect, it } from "vitest";

import { loadRivetkit } from "../src/load-rivetkit.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function stopLocalEngines(): void {
	const listed = spawnSync("pgrep", ["-x", "rivet-engine"], {
		encoding: "utf8",
	});
	const pids = listed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^\d+$/.test(line));
	for (const pid of pids) {
		spawnSync("kill", [pid], { stdio: "ignore" });
	}
}

describe("rivetkit live baremetal", () => {
	it("loads rivetkit from CJS via dynamic import", {
		timeout: 30_000,
	}, async () => {
		const result = await new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
		}>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--input-type=commonjs",
					"-e",
					`import("rivetkit").then((m) => {
  if (!(m.actor instanceof Function) || !(m.setup instanceof Function)) {
    throw new Error("cjs dynamic import did not yield actor/setup");
  }
  process.stdout.write("cjs-ok");
}).catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});`,
				],
				{ cwd: PACKAGE_ROOT },
			);
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("cjs load timeout"));
			}, 15_000);
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (status) => {
				clearTimeout(timer);
				resolve({ status, stdout, stderr });
			});
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("cjs-ok");
	});

	it("starts the native engine and invokes an action", {
		timeout: 60_000,
	}, async (ctx) => {
		stopLocalEngines();
		const previousHome = process.env.HOME;
		const home = await mkdtemp(join(tmpdir(), "hobo-rivet-home-"));
		process.env.HOME = home;
		try {
			const rivet = await loadRivetkit();
			const ping = rivet.actor({
				state: { n: 0 },
				actions: { ping: () => "pong" },
			});
			const registry = rivet.setup({
				use: { ping },
				noWelcome: true,
				shutdown: {
					gracePeriodMs: 2_000,
					disableSignalHandlers: true,
				},
			});
			const { client } = await setupTest(ctx, registry);
			interface LivePingHandle {
				ping: () => Promise<string>;
			}
			interface LivePingClient {
				ping: {
					getOrCreate: (key: string[]) => LivePingHandle;
				};
			}
			const pingClient = client as LivePingClient;
			const handle = pingClient.ping.getOrCreate([`live-${Date.now()}`]);
			expect(await handle.ping()).toBe("pong");
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			stopLocalEngines();
		}
	});
});
