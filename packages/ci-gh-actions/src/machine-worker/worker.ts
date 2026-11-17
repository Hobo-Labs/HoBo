/**
 * The machine worker behind `hobo ci machine connect` (ADR-0183): a computer
 * its owner connects so jobs routed to it run there.
 *
 * Each `tick` renews the machine's signed advert when it is due (every 30 s,
 * or at once when what it says changed), then takes jobs for the machine's
 * label up to its free slots. For each job it asks GitHub for a one-job
 * runner on the job's repository, checks the configuration with
 * `parseJitConfig` before anything uses it, and hands it to the executor: a
 * fresh container by default, the host with `--host`. The runner is removed
 * when the job is done, so the machine keeps no permanent runner.
 *
 * A public repository's job, and a fork's pull request, never run on a
 * machine (ADR-0183 D7): the worker refuses them before it makes a runner.
 *
 * `drain` takes the machine offline, stops taking jobs and lets the running
 * ones finish; `handOff` stops the running ones too, so GitHub gives their
 * labels' next jobs to whoever routes them next. Either way the advert is
 * withdrawn before anything waits on a job, and never renewed afterwards, so
 * the next decision passes the machine over.
 *
 * The clock, GitHub, the registry and the executor are all passed in.
 */
import type {
	MachineAdvert,
	MachineSharing,
	SignedMachineAdvert,
} from "@hobo/ci";
import type { MeshIdentity } from "@hobo/ci/mesh";
import {
	JitConfigRejection,
	parseJitConfig,
} from "../runner-protocol/jit-config.js";
import {
	MACHINE_ADVERT_EVERY_MS,
	type MachineAdvertSink,
	type MachineProfile,
	machineRunsOnLabel,
	signedMachineAdvert,
} from "./advert.js";
import type { JobExecutor } from "./executor.js";
import {
	createOneJobRunner,
	type MachineGithub,
	type MachineJobOffer,
	type MachineJobSource,
	type OneJobRunner,
	OneJobRunnerError,
	removeOneJobRunner,
} from "./jobs.js";
import {
	type MachineWorkerEvent,
	type WorkerEventType,
	workerEvent,
} from "./records.js";

/** What the worker did, one event at a time; `--events` prints each as a JSON line. */
export type { MachineWorkerEvent };

export type MachineWorkerOptions = Readonly<{
	profile: MachineProfile;
	identity: MeshIdentity;
	sink: MachineAdvertSink;
	jobs: MachineJobSource;
	/** GitHub as the owner: makes and removes one-job runners. */
	github: MachineGithub;
	executor: JobExecutor;
	/** Jobs at once. */
	concurrency: number;
	/** Used when the machine is new; the registry keeps the owner's later choice. */
	sharing: MachineSharing;
	now: () => number;
	emit: (event: MachineWorkerEvent) => void;
	advertiseEveryMs?: number;
}>;

export type MachineWorkerStatus = Readonly<{
	advert: MachineAdvert | undefined;
	running: number;
	paused: boolean;
	stopping: boolean;
	/** Set when the registry refused the machine for good (a takeover). */
	refused: string | undefined;
	finished: number;
	failed: number;
}>;

export type MachineWorker = Readonly<{
	/** Renew the advert when due and take the jobs there is room for. */
	tick(): Promise<void>;
	/** Pause (true) or resume (false), as the owner would with `hobo ci machine pause`. */
	setPaused(paused: boolean): Promise<void>;
	/** Go offline at once, take no new jobs, and let running ones finish. */
	drain(): Promise<void>;
	/** Go offline at once and stop the running jobs. */
	handOff(): Promise<void>;
	status(): MachineWorkerStatus;
}>;

type Running = Readonly<{
	offer: MachineJobOffer;
	controller: AbortController;
	done: Promise<void>;
}>;

/** The one-job runner's name for a job: unique per job and machine. */
export function oneJobRunnerName(machineId: string, jobId: number): string {
	return `${machineRunsOnLabel(machineId)}-${jobId}`;
}

export function createMachineWorker(
	options: MachineWorkerOptions,
): MachineWorker {
	const { profile } = options;
	const everyMs = options.advertiseEveryMs ?? MACHINE_ADVERT_EVERY_MS;
	const running = new Map<number, Running>();
	// A refused job is refused once per session, however often it is offered.
	const refusedJobs = new Set<number>();
	let paused = false;
	let stopping = false;
	let offline = false;
	let refused: string | undefined;
	let lastAdvertMs: number | undefined;
	let lastPickedAtMs = 0;
	let changed = true;
	let kept: MachineAdvert | undefined;
	let finished = 0;
	let failed = 0;

	function signed(): SignedMachineAdvert {
		return signedMachineAdvert(
			profile,
			{
				slots: options.concurrency,
				busy: running.size,
				paused,
				sharing: options.sharing,
				lastPickedAtMs,
				nowMs: options.now(),
			},
			options.identity,
		);
	}

	async function advertise(): Promise<void> {
		const nowMs = options.now();
		const verdict = await options.sink.advertise(signed(), nowMs);
		lastAdvertMs = nowMs;
		changed = false;
		for (const event of verdict.events) options.emit(event);
		if (verdict.kind === "refused") {
			options.emit(
				workerEvent({
					type: "worker.refused",
					machineId: profile.id,
					atMs: nowMs,
					reason: verdict.reason,
					detail: verdict.message,
				}),
			);
			// A takeover or another owner stays refused until the owner removes
			// the machine; a stale or malformed advert is retried next time.
			if (verdict.reason === "taken_over" || verdict.reason === "wrong_owner")
				refused = verdict.message;
			return;
		}
		kept = verdict.advert;
		// The owner's pause, from this terminal or `hobo ci machine pause`, wins.
		paused = verdict.advert.paused;
		options.emit(
			workerEvent({
				type: "worker.advertised",
				machineId: profile.id,
				atMs: nowMs,
				busy: verdict.advert.busy,
				slots: verdict.advert.slots,
				paused,
			}),
		);
	}

	function jobEvent(
		type: Extract<
			WorkerEventType,
			| "worker.job_started"
			| "worker.job_finished"
			| "worker.job_failed"
			| "worker.job_refused"
		>,
		offer: MachineJobOffer,
		runner: string | undefined,
		detail: string,
	): MachineWorkerEvent {
		const base = {
			type,
			machineId: profile.id,
			atMs: options.now(),
			jobId: offer.jobId,
			repository: offer.repository,
			detail,
		};
		return workerEvent(runner === undefined ? base : { ...base, runner });
	}

	async function runJob(
		offer: MachineJobOffer,
		controller: AbortController,
	): Promise<void> {
		const name = oneJobRunnerName(profile.id, offer.jobId);
		let runner: OneJobRunner | undefined;
		try {
			runner = await createOneJobRunner(options.github, {
				repository: offer.repository,
				name,
				labels: [machineRunsOnLabel(profile.id)],
			});
			// Checked before the runner program, or anything else, sees it.
			parseJitConfig(runner.encodedJitConfig, { runnerName: name });
			options.emit(
				jobEvent(
					"worker.job_started",
					offer,
					name,
					`A one-job runner ${name} took job ${offer.jobId} of ${offer.repository} in ${options.executor.isolation === "container" ? "a fresh container" : "this machine's host"}.`,
				),
			);
			const outcome = await options.executor.run({
				name,
				encodedJitConfig: runner.encodedJitConfig,
				signal: controller.signal,
			});
			if (outcome.stopped) {
				failed += 1;
				options.emit(
					jobEvent(
						"worker.job_failed",
						offer,
						name,
						`The runner for job ${offer.jobId} was stopped before it finished.`,
					),
				);
			} else {
				finished += 1;
				options.emit(
					jobEvent(
						"worker.job_finished",
						offer,
						name,
						`The runner for job ${offer.jobId} exited${outcome.exitCode === undefined ? "" : ` with code ${outcome.exitCode}`}.`,
					),
				);
			}
		} catch (error) {
			failed += 1;
			const detail =
				error instanceof JitConfigRejection
					? `GitHub's one-job runner configuration was refused before use: ${error.message}.`
					: error instanceof OneJobRunnerError
						? error.message
						: `The job could not run: ${error instanceof Error ? error.message : "unknown error"}.`;
			options.emit(jobEvent("worker.job_failed", offer, runner?.name, detail));
		} finally {
			// GitHub removes a one-job runner after its job; one that never got
			// a job, or was stopped, is removed here so none stays registered.
			if (runner)
				await removeOneJobRunner(options.github, runner).catch(() => false);
			running.delete(offer.jobId);
			changed = true;
		}
	}

	function admissible(offer: MachineJobOffer): string | undefined {
		if (!offer.private)
			return `${offer.repository} is public; a public repository's jobs never run on a machine.`;
		if (offer.fork)
			return `Job ${offer.jobId} is a pull request from a fork; fork pull requests never run on a machine.`;
		return undefined;
	}

	async function goOffline(): Promise<void> {
		if (offline || !kept) {
			offline = true;
			return;
		}
		offline = true;
		options.emit(await options.sink.offline(kept, options.now()));
	}

	async function settle(): Promise<void> {
		await Promise.all([...running.values()].map((job) => job.done));
	}

	return {
		async tick() {
			if (stopping || refused !== undefined) return;
			const nowMs = options.now();
			if (
				changed ||
				lastAdvertMs === undefined ||
				nowMs - lastAdvertMs >= everyMs
			)
				await advertise();
			if (refused !== undefined || kept === undefined || paused) return;
			const room = options.concurrency - running.size;
			if (room <= 0) return;
			for (const offer of await options.jobs.take(room, nowMs)) {
				if (running.has(offer.jobId) || refusedJobs.has(offer.jobId)) continue;
				const refusal = admissible(offer);
				if (refusal !== undefined) {
					refusedJobs.add(offer.jobId);
					options.emit(
						jobEvent("worker.job_refused", offer, undefined, refusal),
					);
					continue;
				}
				const controller = new AbortController();
				lastPickedAtMs = options.now();
				changed = true;
				// `runJob` reaches its first await before it can delete the entry.
				running.set(offer.jobId, {
					offer,
					controller,
					done: runJob(offer, controller),
				});
			}
			// Advertise the busy slots at once so a relay does not over-assign.
			if (changed) await advertise();
		},
		async setPaused(next) {
			// Offline stays offline: a pause after a stop would renew the advert.
			if (stopping || refused !== undefined) return;
			if (!kept) {
				paused = next;
				changed = true;
				return;
			}
			const event = await options.sink.setPaused(kept, next, options.now());
			if (event) options.emit(event);
			paused = next;
			changed = true;
			await advertise();
		},
		async drain() {
			if (!stopping) {
				stopping = true;
				options.emit(
					workerEvent({
						type: "worker.draining",
						machineId: profile.id,
						atMs: options.now(),
						running: running.size,
						detail:
							running.size === 0
								? "Taking no new jobs; going offline."
								: `Offline; taking no new jobs and waiting for ${running.size} running job(s) to finish. Press Ctrl-C again to stop them.`,
					}),
				);
			}
			// The advert goes first, so no decision routes here while jobs end.
			try {
				await goOffline();
			} finally {
				await settle();
			}
		},
		async handOff() {
			stopping = true;
			options.emit(
				workerEvent({
					type: "worker.handing_off",
					machineId: profile.id,
					atMs: options.now(),
					running: running.size,
					detail: `Going offline and stopping ${running.size} running job(s).`,
				}),
			);
			try {
				await goOffline();
			} finally {
				for (const job of running.values()) job.controller.abort();
				await settle();
			}
		},
		status() {
			return {
				advert: kept,
				running: running.size,
				paused,
				stopping,
				refused,
				finished,
				failed,
			};
		},
	};
}
