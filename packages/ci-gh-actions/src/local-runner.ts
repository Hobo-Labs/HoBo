import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { freemem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	RUNNER_SHA256,
	RUNNER_URL,
	runHostProcess,
	runnerEnvironment,
} from "./bootstrap.js";
import {
	type JoinedMesh,
	joinMeshFromEnv,
	meshNodeIdFromEnv,
} from "./mesh-join.js";
import {
	createMeshReliabilityLedger,
	freeDiskMb,
	type MeshJournal,
	type MeshNodeEvent,
	meshReliabilityJournal,
	meshReliabilityResetToken,
} from "./mesh-node.js";
import { meshNodeReportsJson } from "./mesh-records.js";

const exec = promisify(execFile);
const LOCAL_HOST_LABEL = "hobo-local-host";
const repositoryName = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
	.refine((value) => ![".", ".."].includes(value.split("/")[1] ?? ""));
const repository = z.object({
	full_name: repositoryName,
	private: z.boolean(),
});
const jitResponse = z.object({
	runner: z.object({ id: z.number().int().positive() }),
	encoded_jit_config: z.string().optional(),
});
const jit = jitResponse.extend({
	encoded_jit_config: z
		.string()
		.min(1)
		.regex(/^[A-Za-z0-9+/=]+$/),
});
const jitRequest = z.object({
	name: z.string(),
	runner_group_id: z.literal(1),
	labels: z.array(z.literal("hobo-local-host")),
	work_folder: z.literal("_work"),
});
export type LocalRunnerJitRequest = z.infer<typeof jitRequest>;
export type LocalRunnerApiResponse =
	| z.infer<typeof repository>
	| z.infer<typeof jitResponse>
	| null;

const registration = z.object({
	repository: repositoryName,
	id: z.number().int().positive().optional(),
	name: z.string().optional(),
	uncertain: z.boolean().default(false),
});
export class LocalRunnerShutdownUncertainError extends Error {
	constructor() {
		super(
			"Local runner shutdown is uncertain; verify and stop the retained host processes before clearing .hobo/ci-local/registration.json",
		);
	}
}
export class LocalRunnerRegistrationUncertainError extends Error {
	constructor(name: string) {
		super(
			`Local runner registration is uncertain (${name}); verify/remove that GitHub runner before clearing registration.json and restarting`,
		);
	}
}
export class LocalRunnerApiRejectedError extends Error {
	constructor() {
		super(
			"GitHub runner API failed; check gh authentication and repository administration permission",
		);
	}
}

/** gh is the controller's credential boundary. Never include its output in errors/logs. */
export async function githubLocalRunnerApi(
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: LocalRunnerJitRequest,
): Promise<LocalRunnerApiResponse> {
	const payload = body ? JSON.stringify(jitRequest.parse(body)) : undefined;
	return new Promise((resolve, reject) => {
		const child = execFile(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				"--method",
				method,
				"-H",
				"Accept: application/vnd.github+json",
				"-H",
				"X-GitHub-Api-Version: 2022-11-28",
				path,
				...(body ? ["--input", "-"] : []),
			],
			{ timeout: 30000, maxBuffer: 1024 * 1024, env: process.env },
			(error, stdout, stderr) => {
				if (error) {
					if (method === "DELETE" && /HTTP 404/.test(stderr)) {
						resolve(null);
						return;
					}
					if (/HTTP 4\d\d/.test(stderr)) {
						reject(new LocalRunnerApiRejectedError());
						return;
					}
					reject(
						new Error(
							"GitHub runner API failed; check gh authentication and repository administration permission",
						),
					);
					return;
				}
				try {
					const data: unknown = stdout.trim() ? JSON.parse(stdout) : null;
					resolve(
						method === "GET"
							? repository.parse(data)
							: method === "POST"
								? jitResponse.parse(data)
								: null,
					);
				} catch {
					reject(new Error("invalid GitHub runner API response"));
				}
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(payload);
	});
}

export function parseLocalRunnerEnvironment(env: NodeJS.ProcessEnv) {
	if (env.HOBO_CI_LOCAL_TRUSTED !== "1")
		throw new Error(
			"Set HOBO_CI_LOCAL_TRUSTED=1 for a private repository whose matching jobs are trusted with this dev machine",
		);
	return repositoryName.parse(env.HOBO_CI_LOCAL_REPOSITORY);
}

/** Cache only verified archive bytes; each job gets a fresh extraction and HOME. */
export async function installLocalRunnerArchive(
	state: string,
	signal?: AbortSignal,
): Promise<string> {
	await mkdir(state, { recursive: true, mode: 0o700 });
	await chmod(state, 0o700);
	const archive = join(state, `runner-${RUNNER_SHA256}.tar.gz`);
	const matches = (bytes: Buffer) =>
		createHash("sha256").update(bytes).digest("hex") === RUNNER_SHA256;
	try {
		if (matches(await readFile(archive))) return archive;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	const response = await fetch(RUNNER_URL, {
		signal: AbortSignal.any([
			AbortSignal.timeout(120000),
			...(signal ? [signal] : []),
		]),
	});
	if (!response.ok) throw new Error("official runner download failed");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (!matches(bytes)) throw new Error("official runner checksum mismatch");
	await writeFile(archive, bytes, { mode: 0o600 });
	return archive;
}

/** What a session tells whoever is reporting this machine to the mesh. */
export type LocalRunnerSessionObserver = Readonly<{
	/** A runner is registered and waiting for a job in `work`. */
	waiting(work: string): void;
	/**
	 * The session is over. `delivered`: the runner ran to its own exit.
	 * `dropped`: it was registered and then failed. `idle`: it was stopped, or
	 * never got as far as registering; nothing to count.
	 */
	ended(outcome: "delivered" | "dropped" | "idle"): void;
}>;

/** One disposable host registration, including removal before the next registration. */
export async function runLocalRunnerSession(options: {
	repository: string;
	state: string;
	archive: string;
	api?: typeof githubLocalRunnerApi;
	env?: NodeJS.ProcessEnv;
	registered?: () => Promise<void>;
	signal?: AbortSignal;
	/** Told when a runner starts waiting and how the session ended. */
	observer?: LocalRunnerSessionObserver | undefined;
}): Promise<void> {
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error(
			"local HoBo bridge requires Linux x64; use act for offline workflows on other platforms",
		);
	const name = repositoryName.parse(options.repository);
	options.signal?.throwIfAborted();
	const api = options.api ?? githubLocalRunnerApi;
	const pendingFile = join(options.state, "registration.json");
	let pending: z.infer<typeof registration> | undefined;
	try {
		pending = registration.parse(
			JSON.parse(await readFile(pendingFile, "utf8")),
		);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	if (pending) {
		if (pending.id === undefined)
			throw new LocalRunnerRegistrationUncertainError(
				pending.name ?? "unknown runner name",
			);
		if (pending.uncertain) throw new LocalRunnerShutdownUncertainError();
		if (pending.repository !== name)
			throw new Error(
				"Drain the previous local repository registration before changing repositories",
			);
		await api("DELETE", `/repos/${name}/actions/runners/${pending.id}`);
		await rm(pendingFile);
	}
	const remote = repository.parse(await api("GET", `/repos/${name}`));
	if (!remote.private)
		throw new Error(
			"local host requires a private trusted repository; public repository jobs need an isolated host",
		);
	if (remote.full_name.toLowerCase() !== name.toLowerCase())
		throw new Error("GitHub repository identity changed");
	options.signal?.throwIfAborted();
	const work = await mkdtemp(join(options.state, "host-"));
	let runnerId: number | undefined;
	let uncertain = false;
	let failure: Error | undefined;
	let outcome: "delivered" | "dropped" | "idle" = "idle";
	try {
		await exec("tar", ["xzf", options.archive, "-C", work], { timeout: 60000 });
		options.signal?.throwIfAborted();
		const home = join(work, "home");
		const temp = join(work, "temp");
		await mkdir(home, { mode: 0o700 });
		await mkdir(temp, { mode: 0o700 });
		const runnerName = `hobo-local-${randomUUID()}`;
		// Record launch intent before the external mutation: a lost response is not a refusal.
		await writeFile(
			pendingFile,
			JSON.stringify({ repository: name, name: runnerName, uncertain: true }),
			{ mode: 0o600 },
		);
		let response: LocalRunnerApiResponse;
		try {
			response = await api(
				"POST",
				`/repos/${name}/actions/runners/generate-jitconfig`,
				{
					name: runnerName,
					runner_group_id: 1,
					labels: [LOCAL_HOST_LABEL],
					work_folder: "_work",
				},
			);
		} catch (error) {
			if (error instanceof LocalRunnerApiRejectedError) {
				await rm(pendingFile);
				throw error;
			}
			throw new LocalRunnerRegistrationUncertainError(runnerName);
		}
		runnerId = jit.pick({ runner: true }).parse(response).runner.id;
		await writeFile(
			pendingFile,
			JSON.stringify({ repository: name, id: runnerId, uncertain: true }),
			{ mode: 0o600 },
		);
		const configuration = jit.parse(response);
		options.signal?.throwIfAborted();
		await options.registered?.();
		options.signal?.throwIfAborted();
		options.observer?.waiting(work);
		try {
			await runHostProcess(
				join(work, "run.sh"),
				["--jitconfig", configuration.encoded_jit_config],
				work,
				{
					...runnerEnvironment(options.env ?? process.env),
					HOME: home,
					TMPDIR: temp,
				},
				undefined,
				options.signal,
			);
			outcome = "delivered";
		} catch (error) {
			// Stopped on request is not a job this machine lost.
			if (!options.signal?.aborted) outcome = "dropped";
			if (
				error instanceof Error &&
				error.message.includes("shutdown could not be confirmed")
			) {
				uncertain = true;
				throw new LocalRunnerShutdownUncertainError();
			}
			throw error;
		}
	} catch (error) {
		failure =
			error instanceof Error ? error : new Error("Local runner session failed");
	} finally {
		try {
			// GitHub may already remove an ephemeral runner. The API adapter handles 404.
			if (runnerId !== undefined && !uncertain) {
				let removed = false;
				try {
					await api("DELETE", `/repos/${name}/actions/runners/${runnerId}`);
					removed = true;
				} catch (error) {
					await writeFile(
						pendingFile,
						JSON.stringify({
							repository: name,
							id: runnerId,
							uncertain: false,
						}),
						{ mode: 0o600 },
					);
					failure =
						error instanceof Error
							? error
							: new Error("Local runner removal failed");
				}
				if (removed) await rm(pendingFile, { force: true });
			}
		} finally {
			options.observer?.ended(outcome);
			if (!uncertain) await rm(work, { recursive: true, force: true });
		}
	}
	if (failure) throw failure;
}

/** The file a local runner keeps its own mesh report in, beside its other state. */
export const LOCAL_RUNNER_MESH_REPORT = "mesh-node.json";

/**
 * Whether the runner waiting in `work` has been given a job. The runner
 * starts a worker process for the job it is assigned, and that process opens
 * a `Worker_*.log` in the runner's `_diag` folder; a waiting runner has none.
 */
function runnerHasJob(work: string): boolean {
	try {
		return readdirSync(join(work, "_diag")).some((name) =>
			name.startsWith("Worker_"),
		);
	} catch {
		return false;
	}
}

/**
 * This machine as a mesh node. A developer's or an agent's machine that
 * runs jobs for one repository is capacity like any other, so it says so:
 * one slot, free while its runner waits for a job, with the memory and disk
 * it has to give. With `HOBO_CI_NATS_URL` set it advertises to that mesh,
 * signed with its own identity key. Without it the machine is offline and
 * still writes its own report to `mesh-node.json` in `state`, which is what
 * `status` shows when no relay can be asked.
 *
 * It takes no job through the mesh: GitHub assigns its jobs by the
 * `hobo-local-host` label. Its reliability is the share of its sessions
 * whose runner ran to its own exit, kept in `journal` across restarts.
 */
export async function createLocalRunnerMeshNode(options: {
	env: Readonly<Record<string, string | undefined>>;
	state: string;
	hostname: string;
	/** The node's SQLite journal, where its reliability record is kept. */
	journal?: MeshJournal | undefined;
	now?: () => number;
	log?:
		| ((
				event:
					| MeshNodeEvent
					| "hobo_ci_mesh_nats"
					| "hobo_ci_mesh_nodes_capped"
					| "hobo_ci_mesh_reliability_journal_failed",
				fields: Readonly<Record<string, string | number | boolean>>,
		  ) => void)
		| undefined;
}): Promise<
	JoinedMesh & {
		observer: LocalRunnerSessionObserver;
		/** False while the controller cannot run jobs (blocked, or waiting on a fix). */
		setHealthy(healthy: boolean): void;
	}
> {
	const now = options.now ?? Date.now;
	// A worker on the same host has the host's name; this node is told apart.
	const defaultNodeId = `local-${options.hostname}`;
	const stored = options.journal
		? meshReliabilityJournal(
				options.journal,
				meshNodeIdFromEnv(options.env, defaultNodeId),
				(message) =>
					options.log?.("hobo_ci_mesh_reliability_journal_failed", { message }),
				// The same one-shot reset a box worker takes.
				meshReliabilityResetToken(options.env.HOBO_CI_MESH_RELIABILITY_RESET),
			)
		: undefined;
	// Advertised so the relay can show this machine in full to the account
	// that owns the repository, and only to it.
	const served = repositoryName.safeParse(options.env.HOBO_CI_LOCAL_REPOSITORY);
	const ledger = createMeshReliabilityLedger({
		initial: (await stored?.load(now()))?.record,
		persist: (record) => void stored?.save(record),
		now,
	});
	let waitingIn: string | undefined;
	let healthy = true;
	const reportFile = join(options.state, LOCAL_RUNNER_MESH_REPORT);
	const joined = await joinMeshFromEnv({
		env: options.env,
		defaultNodeId,
		keyFile: join(options.state, "mesh-node.key"),
		connectionName: `hobo-ci-local ${options.hostname}`,
		describe: () => ({
			// One job at a time; the slot is free while a runner waits for one.
			freeSlots: waitingIn !== undefined && !runnerHasJob(waitingIn) ? 1 : 0,
			totalSlots: 1,
			healthy,
			labels: [LOCAL_HOST_LABEL],
			free: {
				memoryMb: Math.floor(freemem() / (1024 * 1024)),
				diskMb: freeDiskMb(options.state),
			},
			platform: { os: process.platform, arch: process.arch },
			reliability: ledger.score(),
			samples: ledger.samples(),
			repository: served.success ? served.data : undefined,
		}),
		afterBeat: async (node) => {
			// Written whole or not at all: `status` may read it at any moment.
			const temporary = `${reportFile}.${process.pid}.tmp`;
			await writeFile(
				temporary,
				`${meshNodeReportsJson(await node.reports())}\n`,
				{ mode: 0o600 },
			);
			await rename(temporary, reportFile);
		},
		log: options.log,
	});
	return {
		...joined,
		observer: {
			waiting(work) {
				waitingIn = work;
			},
			ended(outcome) {
				waitingIn = undefined;
				if (outcome !== "idle") ledger.count(outcome);
			},
		},
		setHealthy(next) {
			healthy = next;
		},
	};
}
