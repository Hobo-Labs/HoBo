import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fromJsonString } from "@bufbuild/protobuf";
import { ACTIVE_STATES, type Lease, LeaseSchema } from "@hobo/ci";
import type { MeshNode } from "@hobo/ci/mesh";
import { z } from "zod";
import { meshAdvertJson, parseMeshAdvert } from "./mesh-records.js";
import type { RunnerHostKind } from "./runner-fleet-delivery.js";
import type {
	RunnerHostJobs,
	RunnerHostRegistration,
} from "./runner-host-realizer.js";

// public-contract: the marker file that closes a worker's admission while it exists.
export const WORKER_ADMISSION_PAUSED_FILE = "admission-paused";
// public-contract: the file a worker rewrites with its own mesh advert after every beat.
export const WORKER_MESH_ADVERT_FILE = "mesh-advert.json";
// public-contract: the file a local runner's controller rewrites with its runner's GitHub presence.
export const WORKER_RUNNER_PRESENCE_FILE = "runner-presence.json";
// public-contract: the file the host's CD agent writes to ask the supervisor for a controller release.
export const CONTROLLER_DESIRED_FILE = "controller-desired.json";
// public-contract: the file the supervisor rewrites with the controller process it runs.
export const CONTROLLER_STATUS_FILE = "controller-status.json";
// public-contract: the directory of controller releases staged by digest (`<hex>.mjs`).
export const CONTROLLER_RELEASES_DIR = "controller-releases";

export const RUNNER_PRESENCE_MAX_AGE_MS = 2 * 60_000;

export type WorkerHostFiles = Readonly<{
	database: string;
	admissionPaused: string;
	meshAdvert: string;
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
		meshAdvert: join(dir, WORKER_MESH_ADVERT_FILE),
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

export async function writeWorkerMeshAdvert(
	files: WorkerHostFiles,
	node: MeshNode,
	controllerDigest?: string | undefined,
): Promise<void> {
	const advert = meshAdvertJson(node);
	await writeFileAtomically(
		files.meshAdvert,
		controllerDigest && CONTROLLER_DIGEST.test(controllerDigest)
			? JSON.stringify({ ...JSON.parse(advert), controllerDigest })
			: advert,
	);
}

const AdvertController = z.object({
	controllerDigest: z.string().regex(CONTROLLER_DIGEST).optional(),
});

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
		hostKind: RunnerHostKind;
		now?: (() => number) | undefined;
	}>,
): RunnerHostJobs {
	const { files } = input;
	const now = input.now ?? Date.now;
	const jobs: RunnerHostJobs = {
		async leases() {
			return existsSync(files.database) ? readWorkerLeases(files.database) : [];
		},
		async meshAdvert() {
			try {
				const text = await readFile(files.meshAdvert, "utf8");
				const node = parseMeshAdvert(text);
				if (!node) return undefined;
				const extra = AdvertController.safeParse(JSON.parse(text));
				const controllerDigest = extra.success
					? extra.data.controllerDigest
					: undefined;
				return controllerDigest ? { ...node, controllerDigest } : node;
			} catch {
				return undefined;
			}
		},
		async runners() {
			return input.hostKind === "local-runner"
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
