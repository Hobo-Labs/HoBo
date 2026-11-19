import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadRivetkit, loadRivetkitClient } from "../src/load-rivetkit.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE_FIXTURE = fileURLToPath(
	new URL("./fixtures/rivet3-live.mjs", import.meta.url),
);
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

describe("rivetkit live baremetal", () => {
	it("loads RivetKit and its client from ESM and CommonJS", {
		timeout: 30_000,
	}, async () => {
		const rivet = await loadRivetkit();
		const client = await loadRivetkitClient();
		expect(rivet.actor).toBeInstanceOf(Function);
		expect(rivet.setup).toBeInstanceOf(Function);
		expect(client.createClient).toBeInstanceOf(Function);
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

	it("runs a stateful actor on an isolated Rivet 3 engine", {
		timeout: 65_000,
	}, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-rivet-live-"));
		try {
			const result = await new Promise<{
				status: number | null;
				stdout: string;
				stderr: string;
				timedOut: boolean;
			}>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					["--import", TSX_LOADER, LIVE_FIXTURE],
					{
						cwd: directory,
						detached: process.platform !== "win32",
						env: { PATH: process.env.PATH, NODE_ENV: "test" },
					},
				);
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				const stopOwnedGroup = () => {
					try {
						if (process.platform !== "win32" && child.pid !== undefined)
							process.kill(-child.pid, "SIGKILL");
						else child.kill("SIGKILL");
					} catch (error) {
						// SAFETY: Node's process signalling errors expose an errno code at this OS boundary.
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				};
				const timer = setTimeout(() => {
					timedOut = true;
					stopOwnedGroup();
				}, 55_000);
				child.stdout.on("data", (chunk) => {
					stdout = (stdout + chunk).slice(-20_000);
				});
				child.stderr.on("data", (chunk) => {
					stderr = (stderr + chunk).slice(-20_000);
				});
				child.once("exit", stopOwnedGroup);
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("close", (status) => {
					clearTimeout(timer);
					resolve({ status, stdout, stderr, timedOut });
				});
			});
			expect(result.timedOut, result.stderr).toBe(false);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("rivet3-live-ok");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
