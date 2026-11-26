import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ACTIVE_STATES, type Lease, LeaseSchema } from "@hobo/ci";
import { type Observation, ObservationSchema } from "@hobo/fleet";
import { z } from "zod";
import type { RunnerHostKind } from "./runner-fleet-delivery.js";
import type {
	RunnerHostJobs,
	RunnerHostRegistration,
} from "./runner-host-realizer.js";

export const WORKER_ADMISSION_PAUSED_FILE = "admission-paused";
export const WORKER_OBSERVATION_FILE = "fleet-observation.json";
export const WORKER_RUNNER_PRESENCE_FILE = "runner-presence.json";
export const CONTROLLER_DESIRED_FILE = "controller-desired.json";
export const CONTROLLER_STATUS_FILE = "controller-status.json";
export const CONTROLLER_RELEASES_DIR = "controller-releases";

export const RUNNER_PRESENCE_MAX_AGE_MS = 2 * 60_000;

export type WorkerHostFiles = Readonly<{
	database: string;
	admissionPaused: string;
	observation: string;
	runnerPresence: string;
	controllerDesired: string;
	controllerStatus: string;
	controllerReleases: string;
}>;

export function workerHostFiles(database: string): WorkerHostFiles {
	const dir = dirname(database);
	return Object.freeze({
		database,
		admissionPaused: join(dir, WORKER_ADMISSION_PAUSED_FILE),
		observation: join(dir, WORKER_OBSERVATION_FILE),
		runnerPresence: join(dir, WORKER_RUNNER_PRESENCE_FILE),
		controllerDesired: join(dir, CONTROLLER_DESIRED_FILE),
		controllerStatus: join(dir, CONTROLLER_STATUS_FILE),
		controllerReleases: join(dir, CONTROLLER_RELEASES_DIR),
	});
}

export async function writeFileAtomically(
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { mode: 0o600 });
	await rename(temporary, path);
}

const CONTROLLER_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function controllerDigestFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): string | undefined {
	const digest = env.HOBO_CI_CONTROLLER_DIGEST?.trim();
	return digest && CONTROLLER_DIGEST.test(digest) ? digest : undefined;
}

export function workerAdmissionPaused(files: WorkerHostFiles): boolean {
	return existsSync(files.admissionPaused);
}

export async function writeWorkerObservation(
	files: WorkerHostFiles,
	observation: Observation,
): Promise<void> {
	if (observation.observerId !== observation.memberId)
		throw new Error("only the host's own observation is written");
	await writeFileAtomically(
		files.observation,
		toJsonString(ObservationSchema, observation),
	);
}

const RunnerPresence = z
	.object({
		observedAtMs: z.number().int().nonnegative(),
		runners: z
			.array(
				z
					.object({
						name: z.string().min(1).max(128),
						status: z.enum(["online", "offline"]),
						busy: z.boolean(),
					})
					.strict(),
			)
			.max(64),
	})
	.strict();

export type WorkerRunnerPresence = z.infer<typeof RunnerPresence>;

export async function writeWorkerRunnerPresence(
	files: WorkerHostFiles,
	presence: WorkerRunnerPresence,
): Promise<void> {
	await writeFileAtomically(
		files.runnerPresence,
		`${JSON.stringify(RunnerPresence.parse(presence))}\n`,
	);
}

export async function readWorkerRunnerPresence(
	files: WorkerHostFiles,
	nowMs: number,
	maxAgeMs = RUNNER_PRESENCE_MAX_AGE_MS,
): Promise<readonly RunnerHostRegistration[]> {
	let report: WorkerRunnerPresence;
	try {
		report = RunnerPresence.parse(
			JSON.parse(await readFile(files.runnerPresence, "utf8")),
		);
	} catch {
		return [];
	}
	if (report.observedAtMs > nowMs || nowMs - report.observedAtMs > maxAgeMs)
		return [];
	return report.runners.map((runner) =>
		Object.freeze({
			name: runner.name,
			presence: Object.freeze({ status: runner.status, busy: runner.busy }),
		}),
	);
}

const Row = z.object({ body: z.string() });

export function readWorkerLeases(database: string): readonly Lease[] {
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT body FROM leases WHERE json_extract(body,'$.state') IN (SELECT value FROM json_each(?)) ORDER BY id",
			)
			.all(JSON.stringify([...ACTIVE_STATES]))
			.map((row) => fromJsonString(LeaseSchema, Row.parse(row).body));
	} finally {
		db.close();
	}
}

export function createWorkerHostJobs(
	input: Readonly<{
		files: WorkerHostFiles;
		hostKind: RunnerHostKind | "local-runner";
		now?: (() => number) | undefined;
	}>,
): RunnerHostJobs {
	const { files } = input;
	const now = input.now ?? Date.now;
	const jobs: RunnerHostJobs = {
		async leases() {
			return existsSync(files.database) ? readWorkerLeases(files.database) : [];
		},
		async observation() {
			try {
				return fromJsonString(
					ObservationSchema,
					await readFile(files.observation, "utf8"),
				);
			} catch {
				return undefined;
			}
		},
		async runners() {
			return input.hostKind === "developer-device" ||
				input.hostKind === "local-runner"
				? readWorkerRunnerPresence(files, now())
				: [];
		},
		async pauseAdmission() {
			await writeFile(files.admissionPaused, "", { mode: 0o600 });
		},
		async resumeAdmission() {
			await rm(files.admissionPaused, { force: true });
		},
	};
	return Object.freeze(jobs);
}
