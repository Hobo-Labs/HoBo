/**
 * The runner controller as a process the worker daemon supervises, and the
 * typed control port the host's CD agent drives it through (plan 0024,
 * decision R2; `deploy/runner-fleet/README.md`).
 *
 * Today's box worker and local runner run as processes, not containers. The
 * runner-host realizer moves them between versions without a shell script,
 * through files in the worker's data directory, the same pattern as the
 * `admission-paused` marker:
 *
 * - **Releases** are single-file Node entries staged by digest in
 *   `controller-releases/<hex>.mjs`. The agent fetches a release (from a
 *   directory or an HTTPS base URL, `releaseFetchFrom`) and keeps it only when
 *   its bytes hash to the digest it was asked for. The supervisor hashes it
 *   again before every launch, so a file changed on disk is never run.
 * - **`controller-desired.json`** is the agent's request: a generation (one
 *   more than any before it) and the digest to run, or none. Only the agent
 *   writes it.
 * - **`controller-status.json`** is the supervisor's answer: the generation
 *   it last acted on, the digest it runs, the process state and pid. Only
 *   the supervisor writes it.
 *
 * The supervisor (`createControllerSupervisor`) stops the old child
 * (SIGTERM, then SIGKILL after a deadline), verifies and starts the new one
 * with `HOBO_CI_CONTROLLER_DIGEST` set, so the worker's advert names its
 * version, and restarts a child that exits on its own, up to a crash limit,
 * after which it reports `failed`. Whether the new version serves is the
 * realizer's call, by observation (status, presence and the mesh advert at
 * the new digest); the supervisor only says what it started.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
	RunnerControllerProcess,
	RunnerControllerProcessState,
	RunnerControllerProcessStatus,
} from "./runner-host-realizer.js";
import {
	type WorkerHostFiles,
	writeFileAtomically,
} from "./runner-host-worker-jobs.js";

const DIGEST = /^sha256:(?<hex>[0-9a-f]{64})$/u;
const REFERENCE_DIGEST = /@sha256:(?<hex>[0-9a-f]{64})$/u;
/** A release is a bundle, not an image: 256 MiB is far above any. */
const MAX_RELEASE_BYTES = 256 * 1024 * 1024;

const sha256 = (bytes: Uint8Array) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** `sha256:<hex>` of a digest-pinned reference (`<source>@sha256:<hex>`). */
export function releaseDigestOf(reference: string): string | undefined {
	const hex = REFERENCE_DIGEST.exec(reference)?.groups?.hex;
	return hex ? `sha256:${hex}` : undefined;
}

/** Where a release with `digest` is staged. */
export function controllerReleasePath(
	files: WorkerHostFiles,
	digest: string,
): string {
	const hex = DIGEST.exec(digest)?.groups?.hex;
	if (!hex) throw new Error(`not a release digest: ${JSON.stringify(digest)}`);
	return join(files.controllerReleases, `${hex}.mjs`);
}

/** The staged release's path when its bytes still hash to `digest`; else undefined. */
export async function verifiedControllerRelease(
	files: WorkerHostFiles,
	digest: string,
): Promise<string | undefined> {
	const path = controllerReleasePath(files, digest);
	try {
		return sha256(await readFile(path)) === digest ? path : undefined;
	} catch {
		return undefined;
	}
}

/** Stage release bytes under their own digest, atomically; returns the digest. */
export async function stageControllerRelease(
	files: WorkerHostFiles,
	bytes: Uint8Array,
): Promise<string> {
	const digest = sha256(bytes);
	await mkdir(files.controllerReleases, { recursive: true, mode: 0o700 });
	await writeFileAtomically(controllerReleasePath(files, digest), bytes);
	if (!(await verifiedControllerRelease(files, digest)))
		throw new Error(`staged release ${digest} does not verify`);
	return digest;
}

// ── Control records ────────────────────────────────────────────────────────

const Digest = z.string().regex(DIGEST);

const Desired = z
	.object({
		generation: z.number().int().positive(),
		digest: Digest.nullable(),
		requestedAtMs: z.number().int().nonnegative(),
	})
	.strict();
export type ControllerDesired = z.infer<typeof Desired>;

const STATES = [
	"starting",
	"running",
	"stopping",
	"stopped",
	"exited",
	"failed",
] as const satisfies readonly RunnerControllerProcessState[];

const Status = z
	.object({
		generation: z.number().int().nonnegative(),
		digest: Digest.optional(),
		state: z.enum(STATES),
		pid: z.number().int().positive().optional(),
		startedAtMs: z.number().int().nonnegative().optional(),
		reason: z.string().max(1024).optional(),
		updatedAtMs: z.number().int().nonnegative(),
	})
	.strict();
type StatusRecord = z.infer<typeof Status>;

async function readJson<T>(
	path: string,
	schema: z.ZodType<T>,
): Promise<T | undefined> {
	try {
		const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export const readControllerDesired = (files: WorkerHostFiles) =>
	readJson(files.controllerDesired, Desired);

export const readControllerStatus = (files: WorkerHostFiles) =>
	readJson(files.controllerStatus, Status);

export async function writeControllerDesired(
	files: WorkerHostFiles,
	desired: ControllerDesired,
): Promise<void> {
	await writeFileAtomically(
		files.controllerDesired,
		`${JSON.stringify(Desired.parse(desired))}\n`,
	);
}

// ── Agent side ─────────────────────────────────────────────────────────────

/** Fetch the bytes of the release a digest-pinned reference names. */
export type ControllerReleaseFetch = (
	reference: string,
	digest: string,
) => Promise<Uint8Array>;

/**
 * Releases from a source: an absolute directory (a mount or a synced
 * artifact store) or an `https://` base URL, holding `<hex>.mjs` per release.
 * The bytes are verified by the caller; a plain `http://` source is refused,
 * and nothing here carries a credential.
 */
export function releaseFetchFrom(
	source: string,
	fetchImpl: typeof fetch = fetch,
): ControllerReleaseFetch {
	if (isAbsolute(source))
		return async (_reference, digest) => {
			const hex = DIGEST.exec(digest)?.groups?.hex ?? "";
			return readFile(join(source, `${hex}.mjs`));
		};
	let base: URL;
	try {
		base = new URL(source.endsWith("/") ? source : `${source}/`);
	} catch {
		throw new Error(
			`controller release source must be an absolute directory or an https:// URL, not ${JSON.stringify(source)}`,
		);
	}
	if (base.protocol !== "https:" || base.username || base.password)
		throw new Error(
			"controller release source must be an https:// URL with no credentials in it",
		);
	return async (_reference, digest) => {
		const hex = DIGEST.exec(digest)?.groups?.hex ?? "";
		const response = await fetchImpl(new URL(`${hex}.mjs`, base), {
			redirect: "error",
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok)
			throw new Error(`release fetch answered HTTP ${response.status}`);
		const length = Number(response.headers.get("content-length") ?? "0");
		if (length > MAX_RELEASE_BYTES) throw new Error("release is too large");
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_RELEASE_BYTES)
			throw new Error("release is too large");
		return bytes;
	};
}

/**
 * The process-mode controller port for the host's CD agent. It writes only
 * `controller-desired.json` and staged releases; it reads the supervisor's
 * status. A release that does not hash to its digest is refused, never kept.
 */
export function createControllerProcessPort(
	input: Readonly<{
		files: WorkerHostFiles;
		fetchRelease: ControllerReleaseFetch;
		now?: (() => number) | undefined;
	}>,
): RunnerControllerProcess {
	const { files } = input;
	const now = input.now ?? Date.now;
	return Object.freeze({
		async stage(reference: string) {
			const digest = releaseDigestOf(reference);
			if (!digest)
				throw new Error(`${reference} is not pinned by @sha256 digest`);
			if (await verifiedControllerRelease(files, digest)) return;
			const bytes = await input.fetchRelease(reference, digest);
			const actual = sha256(bytes);
			if (actual !== digest)
				throw new Error(
					`release digest mismatch: fetched ${actual}, expected ${digest}; nothing was staged`,
				);
			await stageControllerRelease(files, bytes);
		},

		async status(): Promise<RunnerControllerProcessStatus | undefined> {
			const status = await readControllerStatus(files);
			if (!status) return undefined;
			return Object.freeze({
				generation: status.generation,
				state: status.state,
				...(status.digest === undefined
					? undefined
					: { digest: status.digest }),
				...(status.pid === undefined ? undefined : { pid: status.pid }),
				...(status.startedAtMs === undefined
					? undefined
					: { startedAtMs: status.startedAtMs }),
				...(status.reason === undefined
					? undefined
					: { reason: status.reason }),
			});
		},

		async run(digest: string | undefined) {
			if (digest !== undefined) {
				if (!DIGEST.test(digest))
					throw new Error(`not a release digest: ${JSON.stringify(digest)}`);
				if (!(await verifiedControllerRelease(files, digest)))
					throw new Error(`release ${digest} is not staged; stage it first`);
			}
			const [desired, status] = await Promise.all([
				readControllerDesired(files),
				readControllerStatus(files),
			]);
			const generation =
				Math.max(desired?.generation ?? 0, status?.generation ?? 0) + 1;
			await writeControllerDesired(files, {
				generation,
				digest: digest ?? null,
				requestedAtMs: now(),
			});
			return generation;
		},
	});
}

// ── Supervisor side ────────────────────────────────────────────────────────

/** One child the supervisor started. */
export type ControllerChild = Readonly<{
	pid: number | undefined;
	/** Settles with the exit code (null when killed by a signal). */
	exited: Promise<number | null>;
	terminate(signal: "SIGTERM" | "SIGKILL"): void;
}>;

/** How the supervisor starts a verified release: no shell, the entry file only. */
export type ControllerLauncher = (
	input: Readonly<{ entry: string; digest: string }>,
) => ControllerChild;

/**
 * Start a release with this Node binary: `node <entry> ...args`, the given
 * env plus `HOBO_CI_CONTROLLER_DIGEST`. No shell is involved.
 */
export function nodeControllerLauncher(
	input: Readonly<{
		args?: readonly string[];
		env: Readonly<Record<string, string | undefined>>;
		cwd?: string;
	}>,
): ControllerLauncher {
	return ({ entry, digest }) => {
		const child = spawn(process.execPath, [entry, ...(input.args ?? [])], {
			env: { ...input.env, HOBO_CI_CONTROLLER_DIGEST: digest },
			stdio: "inherit",
			...(input.cwd ? { cwd: input.cwd } : undefined),
		});
		const exited = new Promise<number | null>((resolve) => {
			child.once("exit", (code) => resolve(code));
			child.once("error", () => resolve(-1));
		});
		return Object.freeze({
			pid: child.pid,
			exited,
			terminate(signal: "SIGTERM" | "SIGKILL") {
				child.kill(signal);
			},
		});
	};
}

export type ControllerSupervisorOptions = Readonly<{
	files: WorkerHostFiles;
	launch: ControllerLauncher;
	now?: (() => number) | undefined;
	/** How long a stopping child has after SIGTERM before SIGKILL (default 15 min). */
	stopTimeoutMs?: number | undefined;
	/** Restarts allowed inside `crashWindowMs` before the state is `failed` (default 3). */
	crashLimit?: number | undefined;
	crashWindowMs?: number | undefined;
	/** Waits used for the stop deadline (default a timer). */
	sleep?: ((ms: number) => Promise<void>) | undefined;
	log?:
		| ((
				event: string,
				fields: Readonly<Record<string, string | number>>,
		  ) => void)
		| undefined;
}>;

export type ControllerSupervisor = Readonly<{
	/** Act on a new request, or restart a child that exited; single-flight. */
	tick(): Promise<void>;
	/** Stop the child and report `stopped`. */
	shutdown(): Promise<void>;
	/** Pid of the running child, if any (tests, logs). */
	childPid(): number | undefined;
}>;

type Running = {
	digest: string;
	child: ControllerChild;
	startedAtMs: number;
	exitCode: number | null | undefined;
};

/**
 * The daemon-side supervisor. It owns `controller-status.json`; it reads only
 * `controller-desired.json` and the staged releases.
 */
export function createControllerSupervisor(
	options: ControllerSupervisorOptions,
): ControllerSupervisor {
	const { files } = options;
	const now = options.now ?? Date.now;
	const stopTimeoutMs = options.stopTimeoutMs ?? 15 * 60_000;
	const crashLimit = options.crashLimit ?? 3;
	const crashWindowMs = options.crashWindowMs ?? 10 * 60_000;
	const sleep =
		options.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
	const log = options.log ?? (() => undefined);

	let acted = 0;
	let running: Running | undefined;
	let crashes: number[] = [];
	let inFlight: Promise<void> | undefined;

	async function report(
		state: RunnerControllerProcessState,
		extra: Partial<Pick<StatusRecord, "digest" | "reason">> = {},
	) {
		const record: StatusRecord = {
			generation: acted,
			state,
			updatedAtMs: now(),
			...(extra.digest === undefined ? undefined : { digest: extra.digest }),
			...(running?.child.pid === undefined || state === "stopped"
				? undefined
				: { pid: running.child.pid }),
			...(running && state !== "stopped"
				? { startedAtMs: running.startedAtMs }
				: undefined),
			...(extra.reason === undefined ? undefined : { reason: extra.reason }),
		};
		await writeFileAtomically(
			files.controllerStatus,
			`${JSON.stringify(Status.parse(record))}\n`,
		);
	}

	async function stopChild(): Promise<void> {
		const current = running;
		if (!current) return;
		if (current.exitCode === undefined) {
			await report("stopping", { digest: current.digest });
			current.child.terminate("SIGTERM");
			const exited = await Promise.race([
				current.child.exited.then(() => true),
				sleep(stopTimeoutMs).then(() => false),
			]);
			if (!exited) {
				log("hobo_ci_controller_kill", {
					digest: current.digest,
					afterMs: stopTimeoutMs,
				});
				current.child.terminate("SIGKILL");
				await current.child.exited;
			}
		}
		running = undefined;
	}

	/** Verify and start `digest`; false (and `failed`) when it does not verify. */
	async function start(digest: string): Promise<boolean> {
		const entry = await verifiedControllerRelease(files, digest);
		if (!entry) {
			await report("failed", {
				digest,
				reason: `release ${digest} is not staged or does not hash to its digest; not started`,
			});
			return false;
		}
		const child = options.launch({ entry, digest });
		const started: Running = {
			digest,
			child,
			startedAtMs: now(),
			exitCode: undefined,
		};
		running = started;
		void child.exited.then((code) => {
			started.exitCode = code;
		});
		log("hobo_ci_controller_started", {
			digest,
			pid: child.pid ?? 0,
			generation: acted,
		});
		await report("running", { digest });
		return true;
	}

	async function pass(): Promise<void> {
		const desired = await readControllerDesired(files);
		if (desired && desired.generation > acted) {
			acted = desired.generation;
			crashes = [];
			const target = desired.digest ?? undefined;
			if (
				running &&
				running.digest === target &&
				running.exitCode === undefined
			) {
				await report("running", { digest: target });
				return;
			}
			await stopChild();
			if (target === undefined) {
				await report("stopped");
				return;
			}
			await start(target);
			return;
		}
		// Supervision: a child that exited on its own is restarted, within limits.
		if (running && running.exitCode !== undefined) {
			const { digest, exitCode } = running;
			running = undefined;
			const at = now();
			crashes = [...crashes.filter((t) => at - t < crashWindowMs), at];
			log("hobo_ci_controller_exited", {
				digest,
				code: exitCode ?? -1,
				crashes: crashes.length,
			});
			if (crashes.length > crashLimit) {
				await report("failed", {
					digest,
					reason: `exited ${crashes.length} times within ${crashWindowMs} ms (last code ${exitCode ?? "signal"}); not restarted`,
				});
				return;
			}
			await report("exited", {
				digest,
				reason: `exited with ${exitCode ?? "a signal"}; restarting`,
			});
			await start(digest);
			return;
		}
		if (!desired && !running && !existsSync(files.controllerStatus))
			await report("stopped");
	}

	return Object.freeze({
		tick() {
			inFlight ??= pass().finally(() => {
				inFlight = undefined;
			});
			return inFlight;
		},
		async shutdown() {
			await inFlight;
			await stopChild();
			await report("stopped");
		},
		childPid: () =>
			running && running.exitCode === undefined ? running.child.pid : undefined,
	});
}
