import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs a combined HTTP and KV application in a real Rivet 3 registry", {
	timeout: 100_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-rivet-http-kv-live-"));
	const loader = createRequire(import.meta.url).resolve("tsx");
	const fixture = fileURLToPath(
		new URL("./rivet-http-kv-live.mts", import.meta.url),
	);
	try {
		const result = await new Promise<{
			status: number | null;
			output: string;
			timedOut: boolean;
		}>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", loader, fixture], {
				cwd: directory,
				env: {
					PATH: process.env.PATH,
					NODE_ENV: "test",
					TOKIO_WORKER_THREADS: "2",
					NODE_OPTIONS: "--v8-pool-size=1",
					UV_THREADPOOL_SIZE: "1",
				},
				detached: process.platform !== "win32",
			});
			let output = "";
			let timedOut = false;
			const stop = () => {
				try {
					if (process.platform !== "win32" && child.pid !== undefined)
						process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch (error) {
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: process signaling errors carry Node's errno code.
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			};
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, 90_000);
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (chunk) => {
					output = (output + String(chunk)).slice(-20_000);
				});
			child.once("exit", stop);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (status) => {
				clearTimeout(timer);
				resolve({ status, output, timedOut });
			});
		});
		expect(result.timedOut, result.output).toBe(false);
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain("rivet-http-kv-live-ok");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
