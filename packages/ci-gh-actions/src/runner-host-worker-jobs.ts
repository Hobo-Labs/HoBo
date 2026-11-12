/**
 * The runner-host realizer's job ports, read from the box worker across a
 * process boundary (plan 0024; `deploy/runner-fleet/README.md`).
 *
 * The CD agent (`hobo deploy agent run`) and the worker daemon are separate
 * processes on one host. They share the worker's data directory (the
 * directory of `HOBO_CI_WORKER_DB`, bind-mounted into the controller
 * container), and that is the whole interface:
 *
 * - **Leases** are read from the worker's SQLite journal, opened read-only.
 *   The worker stays its only writer (one partition, one writer).
 * - **The mesh advert** is the file the worker rewrites after every mesh
 *   beat (`mesh-advert.json`, the `MeshAdvert` record as JSON): the host's
 *   own advertisement as it last made it.
 * - **The admission gate** is the `admission-paused` marker file. While it
 *   exists the worker admits no new job (its tick runs with `admit: false`)
 *   and advertises itself unhealthy; running jobs are untouched. Removing it
 *   reopens admission on the next tick.
 * - **Runners**: JIT hosts (`box-worker`, `mesh-node`) register a runner per
 *   job, and those jobs are already counted through their leases, so the
 *   port answers no standing registrations. A `local-runner` keeps a
 *   registered runner whose GitHub presence this module cannot read, so the
 *   port is left unwired there and the realizer refuses it by name.
 */
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
import type { RunnerHostJobs } from "./runner-host-realizer.js";

// public-contract: the marker file that closes a worker's admission while it exists.
export const WORKER_ADMISSION_PAUSED_FILE = "admission-paused";
// public-contract: the file a worker rewrites with its own mesh advert after every beat.
export const WORKER_MESH_ADVERT_FILE = "mesh-advert.json";

/** Where a worker and its host's CD agent meet: beside the worker's journal. */
export type WorkerHostFiles = Readonly<{
	database: string;
	admissionPaused: string;
	meshAdvert: string;
}>;

export function workerHostFiles(database: string): WorkerHostFiles {
	const dir = dirname(database);
	return Object.freeze({
		database,
		admissionPaused: join(dir, WORKER_ADMISSION_PAUSED_FILE),
		meshAdvert: join(dir, WORKER_MESH_ADVERT_FILE),
	});
}

/** Whether the host's CD agent has closed this worker's admission. */
export function workerAdmissionPaused(files: WorkerHostFiles): boolean {
	return existsSync(files.admissionPaused);
}

/** Write the worker's own advert for the host's CD agent; atomic (write, then rename). */
export async function writeWorkerMeshAdvert(
	files: WorkerHostFiles,
	node: MeshNode,
): Promise<void> {
	const temporary = `${files.meshAdvert}.${process.pid}.tmp`;
	await writeFile(temporary, meshAdvertJson(node), { mode: 0o600 });
	await rename(temporary, files.meshAdvert);
}

const Row = z.object({ body: z.string() });

/** Active leases in the worker's journal, read without taking its writer lock. */
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

/**
 * The job ports a runner host's agent reads from its worker. A `local-runner`
 * gets no `runners` port (see the module comment), so the realizer refuses
 * `runner-host-interface-missing: … jobs.runners` there rather than guess.
 */
export function createWorkerHostJobs(
	input: Readonly<{ files: WorkerHostFiles; hostKind: RunnerHostKind }>,
): Partial<RunnerHostJobs> {
	const { files } = input;
	const jobs: Partial<RunnerHostJobs> = {
		async leases() {
			// A worker that has not started yet has no journal and no jobs.
			return existsSync(files.database) ? readWorkerLeases(files.database) : [];
		},
		async meshAdvert() {
			try {
				return parseMeshAdvert(await readFile(files.meshAdvert, "utf8"));
			} catch {
				return undefined;
			}
		},
		async pauseAdmission() {
			await writeFile(files.admissionPaused, "", { mode: 0o600 });
		},
		async resumeAdmission() {
			await rm(files.admissionPaused, { force: true });
		},
	};
	if (input.hostKind !== "local-runner") jobs.runners = async () => [];
	return Object.freeze(jobs);
}
