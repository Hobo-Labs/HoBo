import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const fixture = fileURLToPath(
	new URL("./fixtures/rivet-topic-bus-live.mjs", import.meta.url),
);
const loader = createRequire(import.meta.url).resolve("tsx");

it("executes the durable topic bus and client after reopening a real Rivet registry", {
	timeout: 90_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-rivet-topic-bus-live-"));
	try {
		const result = await new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
			timedOut: boolean;
		}>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", loader, fixture], {
				cwd: directory,
				detached: process.platform !== "win32",
				env: { PATH: process.env.PATH, NODE_ENV: "test" },
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const stop = () => {
				try {
					if (process.platform !== "win32" && child.pid !== undefined)
						process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			};
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, 80_000);
			child.stdout.on("data", (chunk) => {
				stdout = (stdout + String(chunk)).slice(-20_000);
			});
			child.stderr.on("data", (chunk) => {
				stderr = (stderr + String(chunk)).slice(-20_000);
			});
			child.once("exit", stop);
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
		expect(result.stdout).toContain(
			"rivet-topic-bus-live-ok registry-reopen=observed process-restart=unverified fault-placement=unverified ingress=unverified contention=unverified rollback=unverified old-owner-fence=unverified",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
