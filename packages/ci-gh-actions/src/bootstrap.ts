import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Keep this source standalone: the relay copies it into connected repositories.
// Official actions/runner release asset SHA-256, retrieved 2026-10-26.
// public-contract: one pinned official release shared by standalone bridge and local installer.
export const RUNNER_VERSION = "2.338.2";
// public-contract: verify the same archive for hosted and local runners (linux x64).
export const RUNNER_SHA256 =
	"baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40";
// public-contract: verify the same archive for hosted and local runners (linux arm64).
export const RUNNER_SHA256_ARM64 =
	"670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945";
// public-contract: the checksum-pinned download endpoint used by both execution paths.
export const RUNNER_URL = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz`;
// public-contract: checksum-pinned download endpoint for linux arm64 runners.
export const RUNNER_URL_ARM64 = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz`;

export type RunnerDownload = { url: string; sha256: string };

/** Pinned runner tarball for the worker/container CPU (linux arm64 or x64 only). */
export function runnerDownloadFor(processArch: string): RunnerDownload {
	if (processArch === "arm64") {
		return { url: RUNNER_URL_ARM64, sha256: RUNNER_SHA256_ARM64 };
	}
	return { url: RUNNER_URL, sha256: RUNNER_SHA256 };
}

/** Deliberate allowlist: never pass outer job context, tokens or cloud credentials. */
export function runnerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	]) {
		if (env[name] !== undefined) result[name] = env[name];
	}
	return result;
}
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
export type HostShutdownTimings = {
	/** How long the process group gets to honour SIGTERM before SIGKILL. */
	readonly graceMs?: number;
	/** How long SIGKILL gets to empty the group before shutdown is unconfirmed. */
	readonly confirmMs?: number;
};
export function runHostProcess(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeout: number | undefined,
	abortSignal?: AbortSignal,
	{ graceMs = 10000, confirmMs = 2000 }: HostShutdownTimings = {},
): Promise<void> {
	if (abortSignal?.aborted) return Promise.reject(abortSignal.reason);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: "inherit",
			detached: true,
		});
		let cancelled = false;
		let stopping = false;
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let failure: Error | undefined;
		let hardStop: NodeJS.Timeout | undefined;
		let deadline: NodeJS.Timeout | undefined;
		let poll: NodeJS.Timeout | undefined;
		const signal = (name: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, name);
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					failure = new Error(
						"runner process group shutdown could not be confirmed",
					);
			}
		};
		const groupRunning = () => {
			if (!child.pid) return false;
			try {
				process.kill(-child.pid, 0);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH")
					return false;
				throw error;
			}
			if (process.platform !== "linux") return true;
			// A container's PID 1 can leave killed orphans as zombies. They cannot
			// execute, but kill(0) still sees their group, so inspect live members.
			for (const pid of readdirSync("/proc")) {
				if (!/^\d+$/.test(pid)) continue;
				let status: string;
				try {
					status = readFileSync(`/proc/${pid}/stat`, "utf8");
				} catch (error) {
					// A process reaped between readdir and read reports either code.
					if (
						error instanceof Error &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "ESRCH")
					)
						continue;
					throw error;
				}
				const fields = status.slice(status.lastIndexOf(")") + 2).split(" ");
				if (
					Number(fields[2]) === child.pid &&
					!["Z", "X"].includes(fields[0] ?? "")
				)
					return true;
			}
			return false;
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(hardStop);
			clearTimeout(deadline);
			clearInterval(poll);
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
			abortSignal?.removeEventListener("abort", stop);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			try {
				if (!exited || groupRunning()) return;
				finish(
					failure ??
						(exitCode === 0 && !cancelled
							? undefined
							: new Error("runner host process failed or timed out")),
				);
			} catch {
				failure = new Error(
					"runner process group shutdown could not be confirmed",
				);
			}
		};
		const shutdown = () => {
			if (stopping || settled) return;
			stopping = true;
			clearTimeout(timer);
			signal("SIGTERM");
			hardStop = setTimeout(() => {
				signal("SIGKILL");
				// Timed from the kill actually sent, never from SIGTERM: after an event-loop
				// stall both timers would come due in one turn, before any check could see
				// the killed group go.
				deadline = setTimeout(() => {
					check();
					finish(
						new Error("runner process group shutdown could not be confirmed"),
					);
				}, confirmMs);
			}, graceMs);
			poll = setInterval(check, 25);
			check();
		};
		const stop = () => {
			if (settled) return;
			cancelled = true;
			shutdown();
		};
		// A persistent local listener has no registration-age deadline. Bridge hosts
		// still pass their explicit lease timeout, and shutdown itself stays bounded.
		const timer = timeout === undefined ? undefined : setTimeout(stop, timeout);
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
		abortSignal?.addEventListener("abort", stop, { once: true });
		child.once("error", (error) => {
			if (!child.pid) finish(error);
			else {
				failure = error;
				shutdown();
			}
		});
		child.once("exit", (code) => {
			exited = true;
			exitCode = code;
			// Successful parents can also leave background work; it belongs to this host.
			shutdown();
			check();
		});
	});
}
async function responseField(
	response: Response,
	field: string,
): Promise<string> {
	if (!response.ok)
		throw new Error(`bootstrap request failed (${response.status})`);
	const json = await response.json();
	if (Object.prototype.toString.call(json) !== "[object Object]")
		throw new Error("invalid bootstrap response");
	const value = Object.getOwnPropertyDescriptor(json, field)?.value;
	if (Object.prototype.toString.call(value) !== "[object String]" || !value)
		throw new Error("invalid bootstrap response field");
	return String(value);
}
/** The runner host's HTTP consumer boundary, shared with executable Pact tests. */
export async function claimRunnerJit(
	relay: URL,
	id: string,
	identity: string,
): Promise<string> {
	const jit = await responseField(
		await fetch(`${relay.origin}/v1/leases/${id}/jit`, {
			method: "POST",
			headers: { Authorization: `Bearer ${identity}` },
			redirect: "error",
			signal: AbortSignal.timeout(30000),
		}),
		"encodedJitConfig",
	);
	if (!/^[A-Za-z0-9+/=]+$/.test(jit))
		throw new Error("invalid runner configuration");
	return jit;
}
export async function bootstrap(): Promise<void> {
	const started = Date.now();
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("initial bridge supports Linux x64 only");
	const relay = new URL(required("HOBO_CI_RELAY_URL"));
	if (
		relay.protocol !== "https:" ||
		relay.username ||
		relay.password ||
		relay.pathname !== "/" ||
		relay.search ||
		relay.hash
	)
		throw new Error("relay must be an HTTPS origin");
	const id = required("HOBO_CI_LEASE_ID");
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid lease id");
	const minutes = Number(required("HOBO_CI_TIMEOUT_MINUTES"));
	if (!Number.isSafeInteger(minutes) || minutes < 2 || minutes > 350)
		throw new Error("invalid host timeout");
	const work = await mkdtemp(join(tmpdir(), "hobo-ci-runner-"));
	try {
		const archiveResponse = await fetch(RUNNER_URL, {
			signal: AbortSignal.timeout(120000),
		});
		if (!archiveResponse.ok) throw new Error("runner download failed");
		const archive = Buffer.from(await archiveResponse.arrayBuffer());
		if (createHash("sha256").update(archive).digest("hex") !== RUNNER_SHA256)
			throw new Error("runner archive checksum mismatch");
		await writeFile(join(work, "runner.tar.gz"), archive, { mode: 0o600 });
		await runHostProcess(
			"tar",
			["xzf", "runner.tar.gz"],
			work,
			runnerEnvironment(process.env),
			60000,
		);
		const tokenUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
		if (
			tokenUrl.protocol !== "https:" ||
			!tokenUrl.hostname.endsWith(".actions.githubusercontent.com")
		)
			throw new Error("unexpected identity endpoint");
		tokenUrl.searchParams.set("audience", relay.origin);
		const identity = await responseField(
			await fetch(tokenUrl, {
				headers: {
					Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
				},
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			}),
			"value",
		);
		if (identity.includes("\n")) throw new Error("missing identity token");
		const jit = await claimRunnerJit(relay, id, identity);
		process.stdout.write(`::add-mask::${jit}\n`);
		const remaining = minutes * 60000 - (Date.now() - started) - 60000;
		if (remaining <= 0) throw new Error("startup exhausted host timeout");
		await runHostProcess(
			join(work, "run.sh"),
			["--jitconfig", jit],
			work,
			runnerEnvironment(process.env),
			remaining,
		);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	bootstrap().catch(() => {
		process.stderr.write("HoBo CI runner bootstrap failed.\n");
		process.exitCode = 1;
	});
}
