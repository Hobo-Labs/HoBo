import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	open,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { z } from "zod";
import {
	combineLocalRunnerObservers,
	createLocalRunnerMeshNode,
	createLocalRunnerPresenceReporter,
	installLocalRunnerArchive,
	LOCAL_RUNNER_ADMISSION_CHECK_MS,
	LOCAL_RUNNER_MESH_REPORT,
	LocalRunnerRegistrationUncertainError,
	LocalRunnerShutdownUncertainError,
	localRunnerWatchAction,
	parseLocalRunnerEnvironment,
	runLocalRunnerSession,
} from "../src/local-runner.js";
import { parseMeshNodeReports } from "../src/mesh-records.js";
import { acquirePartitionLock } from "../src/partition-lock.js";
import {
	releaseEntryPath,
	runningAsControllerRelease,
} from "../src/runner-controller-process.js";
import {
	controllerDigestFromEnv,
	workerAdmissionPaused,
	workerHostFiles,
} from "../src/runner-host-worker-jobs.js";

// Run from a checkout this entry finds the repository from its own place; a
// release (`scripts/build-controller-release.mts`) has no checkout around it,
// so its state directory must be named (HOBO_CI_LOCAL_STATE_DIRECTORY).
const release = runningAsControllerRelease();
const self = fileURLToPath(import.meta.url);
const state = resolve(
	releaseEntryPath({
		env: process.env,
		name: "HOBO_CI_LOCAL_STATE_DIRECTORY",
		release,
		fallback: () =>
			join(
				fileURLToPath(new URL("../../..", import.meta.url)),
				".hobo",
				"ci-local",
			),
	}),
);
const socket = join(
	tmpdir(),
	`hobo-ci-${process.getuid?.()}-${createHash("sha256").update(state).digest("hex").slice(0, 16)}.sock`,
);
const reply = z.object({ status: z.string(), detail: z.string() });
// Where this machine meets its host's CD agent (`hobo deploy agent run`, a
// `local-runner` host): the agent closes admission with the
// `admission-paused` marker here and reads the advert and runner presence
// this controller writes here (src/runner-host-worker-jobs.ts). There is no
// worker journal: a local runner has no leases, only its one runner.
const hostFiles = workerHostFiles(join(state, "worker.sqlite"));
const PAUSED_DETAIL =
	"Admission is closed by this host's CD agent; no runner is registered until it reopens";

/**
 * This machine's own mesh report, as the controller last wrote it: which
 * nodes it sees (itself alone when no mesh is configured), their capacity
 * and trust. Read from disk, so it answers with the controller stopped and
 * with no relay or network; `readAt` says how old it is.
 */
async function meshReport() {
	try {
		const report = parseMeshNodeReports(
			await readFile(join(state, LOCAL_RUNNER_MESH_REPORT), "utf8"),
		);
		return {
			mesh: report.mesh,
			readAt: report.readAt,
			nodes: report.nodes.map((node) => ({
				id: node.id,
				state: node.state,
				slots: `${node.freeSlots}/${node.totalSlots}`,
				freeMemoryMb: node.freeMemoryMb ?? null,
				freeDiskMb: node.freeDiskMb ?? null,
				reliability: node.reliability ?? null,
				trust: node.trust,
			})),
		};
	} catch {
		return undefined;
	}
}
let current = {
	status: "starting",
	detail: "Checking local runner prerequisites",
};
const request = (command: string) =>
	new Promise<z.infer<typeof reply>>((done, reject) => {
		const client = createConnection(socket);
		let response = "";
		client.setTimeout(3000, () =>
			client.destroy(new Error("local runner control timeout")),
		);
		client.once("connect", () => client.end(command));
		client.on("data", (data) => {
			response += String(data);
			if (response.length > 4096)
				client.destroy(new Error("invalid control response"));
		});
		client.once("error", reject);
		client.once("end", () => {
			try {
				done(reply.parse(JSON.parse(response)));
			} catch (error) {
				reject(error);
			}
		});
	});
async function status() {
	try {
		return await request("status");
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				"code" in error &&
				["ENOENT", "ECONNREFUSED"].includes(String(error.code))
			)
		)
			return {
				status: "unknown",
				detail:
					"Local runner control is unavailable; shutdown has not been confirmed",
			};
		try {
			const saved = reply.parse(
				JSON.parse(await readFile(join(state, "status.json"), "utf8")),
			);
			if (saved.status === "blocked") return saved;
		} catch {
			/* No saved state yet. */
		}
		try {
			await access(join(state, "registration.json"));
			return {
				status: "blocked",
				detail:
					"Controller is stopped with an unfinished registration; start for cleanup/recovery",
			};
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return { status: "stopped", detail: "Local runner is not running" };
			return {
				status: "unknown",
				detail:
					"Local runner recovery state is unavailable; shutdown has not been confirmed",
			};
		}
	}
}
async function daemon() {
	await mkdir(state, { recursive: true, mode: 0o700 });
	await chmod(state, 0o700);
	const lock = await acquirePartitionLock(join(state, "service"));
	const stopping = new AbortController();
	const stop = () => stopping.abort();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	// This machine is a mesh node whether or not a mesh is configured: it
	// keeps an identity key and a report of itself, and advertises when
	// HOBO_CI_NATS_URL names a mesh. None of it may stop the runner.
	let journal: SqliteCiStore | undefined;
	let mesh: Awaited<ReturnType<typeof createLocalRunnerMeshNode>> | undefined;
	try {
		journal = new SqliteCiStore(join(state, "mesh-node.sqlite"));
		mesh = await createLocalRunnerMeshNode({
			env: process.env,
			state,
			hostname: hostname(),
			journal,
			hostFiles,
			controllerDigest: controllerDigestFromEnv(process.env),
			log: (event, fields) =>
				process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`),
		});
		mesh.start();
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				event: "hobo_ci_mesh_node_unavailable",
				message: error instanceof Error ? error.message : "unknown",
			})}\n`,
		);
	}
	const update = async (status: string, detail: string) => {
		current = { status, detail };
		mesh?.setHealthy(!["blocked", "waiting", "paused"].includes(status));
		await writeFile(
			join(state, "status.json"),
			`${JSON.stringify(current)}\n`,
			{ mode: 0o600 },
		);
		process.stdout.write(`${JSON.stringify(current)}\n`);
	};
	const server = createServer({ allowHalfOpen: true }, (client) => {
		client.setTimeout(3000, () => client.destroy());
		let command = "";
		client.on("data", (data) => {
			command += String(data);
			if (command.length > 16) client.destroy();
		});
		client.on("error", () => {});
		client.once("end", () => {
			client.end(
				JSON.stringify(
					command === "stop"
						? { status: "stopping", detail: "Draining the local runner" }
						: current,
				),
			);
			if (command === "stop") process.kill(process.pid, "SIGTERM");
		});
	});
	try {
		await rm(socket, { force: true });
		await new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(socket, done);
		});
		await chmod(socket, 0o600);
		process.send?.("ready");
		process.disconnect?.();
		while (!stopping.signal.aborted) {
			// Closed admission: register no runner, and give up a waiting one
			// that has no job (one with a job runs to its end).
			if (workerAdmissionPaused(hostFiles)) {
				if (current.status !== "paused") await update("paused", PAUSED_DETAIL);
				await pause(5000, undefined, { signal: stopping.signal }).catch(
					() => {},
				);
				continue;
			}
			const session = new AbortController();
			let watch: ReturnType<typeof setInterval> | undefined;
			let presence:
				| ReturnType<typeof createLocalRunnerPresenceReporter>
				| undefined;
			try {
				if (process.platform !== "linux" || process.arch !== "x64")
					throw new Error(
						"Local HoBo bridge requires Linux x64; use act on other platforms",
					);
				const repository = parseLocalRunnerEnvironment(process.env);
				const reporter = createLocalRunnerPresenceReporter({
					files: hostFiles,
					repository,
				});
				presence = reporter;
				// Admission is checked every 5 s; presence (a GitHub REST call on
				// the user's own rate limit) only every 45 s, and on every session
				// event the reporter observes.
				let refreshedAtMs = Date.now();
				watch = setInterval(() => {
					const action = localRunnerWatchAction({
						admissionPaused: workerAdmissionPaused(hostFiles),
						work: reporter.work(),
						nowMs: Date.now(),
						presenceRefreshedAtMs: refreshedAtMs,
					});
					if (action === "abort") session.abort();
					else if (action === "refresh") {
						refreshedAtMs = Date.now();
						void reporter.refresh();
					}
				}, LOCAL_RUNNER_ADMISSION_CHECK_MS);
				watch.unref();
				await update("preparing", `Preparing private repository ${repository}`);
				const archive = await installLocalRunnerArchive(state, stopping.signal);
				if (stopping.signal.aborted) break;
				await runLocalRunnerSession({
					repository,
					state,
					archive,
					signal: AbortSignal.any([stopping.signal, session.signal]),
					observer: combineLocalRunnerObservers(
						mesh?.observer,
						reporter.observer,
					),
					registered: () =>
						update(
							"registered",
							`${repository}: hobo-local-host; see runner.log for GitHub connection status`,
						),
				});
			} catch (error) {
				if (session.signal.aborted && !stopping.signal.aborted) {
					await update("paused", PAUSED_DETAIL);
					continue;
				}
				if (
					error instanceof LocalRunnerShutdownUncertainError ||
					error instanceof LocalRunnerRegistrationUncertainError
				) {
					await update("blocked", error.message);
					break;
				}
				if (!stopping.signal.aborted)
					await update(
						"waiting",
						error instanceof Error && !error.message.startsWith("[")
							? error.message
							: "Set HOBO_CI_LOCAL_REPOSITORY=owner/repo and configure gh authentication",
					);
			} finally {
				clearInterval(watch);
				await presence?.refresh();
			}
			if (!stopping.signal.aborted)
				await pause(30000, undefined, { signal: stopping.signal }).catch(
					() => {},
				);
		}
	} finally {
		// A node that is stopping says so, then leaves the board to forget it.
		mesh?.setHealthy(false);
		await mesh?.stop().catch(() => undefined);
		journal?.close();
		// Keep control available until the singleton lock has actually drained.
		await lock.release();
		server.close();
		await rm(socket, { force: true });
		if (current.status !== "blocked") {
			const pending = await access(join(state, "registration.json")).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return false;
					throw error;
				},
			);
			if (pending)
				await update(
					"blocked",
					"Local runner stopped with an unfinished registration; start with the original repository and credentials for cleanup/recovery",
				);
			else await update("stopped", "Local runner stopped");
		}
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
async function main() {
	const command = process.argv[2] ?? "status";
	if (command === "daemon") {
		await daemon();
		return;
	}
	if (command === "status" || command === "stop") {
		let observation = await status();
		if (
			command === "stop" &&
			!["stopped", "blocked"].includes(observation.status)
		) {
			await request("stop");
			const deadline = Date.now() + 150000;
			do {
				await pause(100);
				observation = await status();
				if (Date.now() > deadline)
					throw new Error(
						"Local runner stop is unconfirmed; inspect runner.log before rebuilding",
					);
			} while (!["stopped", "blocked"].includes(observation.status));
		}
		const report = command === "status" ? await meshReport() : undefined;
		process.stdout.write(
			`${JSON.stringify(report ? { ...observation, mesh: report } : observation)}\n`,
		);
		if (command === "stop" && observation.status === "blocked")
			process.exitCode = 1;
		return;
	}
	if (command !== "start")
		throw new Error("Usage: local-runner.ts start|status|stop");
	if (process.env.HOBO_CI_LOCAL_RUNNER === "0") {
		process.stdout.write("Local runner disabled (HOBO_CI_LOCAL_RUNNER=0)\n");
		return;
	}
	const running = await request("status").catch(() => undefined);
	if (running) {
		process.stdout.write(`${JSON.stringify(running)}\n`);
		return;
	}
	await mkdir(state, { recursive: true, mode: 0o700 });
	const log = await open(join(state, "runner.log"), "a", 0o600);
	try {
		const child = spawn(
			process.execPath,
			// A release is plain JavaScript; a checkout's entry runs through tsx.
			release ? [self, "daemon"] : ["--import", "tsx", self, "daemon"],
			{
				cwd: release
					? state
					: fileURLToPath(new URL("../../..", import.meta.url)),
				env: process.env,
				detached: true,
				stdio: ["ignore", log.fd, log.fd, "ipc"],
			},
		);
		await new Promise<void>((done, reject) => {
			const deadline = setTimeout(() => {
				child.kill("SIGTERM");
				reject(
					new Error(
						"local runner startup timed out; check .hobo/ci-local/runner.log",
					),
				);
			}, 10000);
			child.once("message", () => {
				clearTimeout(deadline);
				done();
			});
			child.once("error", (error) => {
				clearTimeout(deadline);
				reject(error);
			});
			child.once("exit", () => {
				clearTimeout(deadline);
				request("status").then(
					() => done(),
					() =>
						reject(
							new Error(
								"local runner failed to start; check .hobo/ci-local/runner.log",
							),
						),
				);
			});
		});
		child.unref();
		process.stdout.write(`${JSON.stringify(await request("status"))}\n`);
	} finally {
		await log.close();
	}
}
main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Local runner failed"}\n`,
	);
	process.exitCode = 1;
});
