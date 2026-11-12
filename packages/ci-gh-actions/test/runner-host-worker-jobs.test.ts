// The runner-host realizer's job ports read from the box worker's data
// directory: the journal read-only, the advert the worker writes, and the
// admission marker it honours. A second process (the CD agent) reads them;
// the worker stays the journal's only writer.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create, toJsonString } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import {
	inFlightJobCount,
	runnerHostInterfaceGaps,
} from "../src/runner-host-realizer.js";
import {
	createWorkerHostJobs,
	readWorkerLeases,
	WORKER_ADMISSION_PAUSED_FILE,
	WORKER_MESH_ADVERT_FILE,
	workerAdmissionPaused,
	workerHostFiles,
	writeWorkerMeshAdvert,
} from "../src/runner-host-worker-jobs.js";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "runner-host-worker-"));
	dirs.push(dir);
	return dir;
}

/** A worker journal with the leases table the worker's store creates. */
function journal(path: string, leases: readonly [string, string][]): void {
	const db = new DatabaseSync(path);
	db.exec(
		"CREATE TABLE leases (id TEXT PRIMARY KEY, job_key TEXT NOT NULL, body TEXT NOT NULL)",
	);
	for (const [id, state] of leases)
		db.prepare("INSERT INTO leases(id, job_key, body) VALUES (?, ?, ?)").run(
			id,
			`job-${id}`,
			toJsonString(
				LeaseSchema,
				// The worker's own JIT runner name: `hobo-<lease uuid>`.
				create(LeaseSchema, { id, state, runnerName: `hobo-${randomUUID()}` }),
			),
		);
	db.close();
}

const advert = {
	id: "box",
	freeSlots: 3,
	totalSlots: 4,
	healthy: true,
	labels: ["hobo", "hobo-trunk"],
	validUntilMs: Date.parse("2026-11-12T10:01:00.000Z"),
	sinceMs: Date.parse("2026-11-12T10:00:00.000Z"),
	platform: { os: "linux", arch: "x64" },
};

describe("the worker's data directory as the runner-host job ports", () => {
	it("places the marker and advert beside the worker's journal", () => {
		const files = workerHostFiles("/var/lib/hobo-ci/worker.sqlite");
		expect(files).toEqual({
			database: "/var/lib/hobo-ci/worker.sqlite",
			admissionPaused: `/var/lib/hobo-ci/${WORKER_ADMISSION_PAUSED_FILE}`,
			meshAdvert: `/var/lib/hobo-ci/${WORKER_MESH_ADVERT_FILE}`,
		});
	});

	it("reads only active leases, read-only, from the worker's journal", async () => {
		const dir = await freshDir();
		const database = join(dir, "worker.sqlite");
		journal(database, [
			["a", "running"],
			["b", "reserved"],
			["c", "completed"],
		]);
		const leases = readWorkerLeases(database);
		expect(leases.map((lease) => lease.id)).toEqual(["a", "b"]);
		expect(inFlightJobCount(leases, [])).toBe(2);
		// Read-only: the agent never takes the worker's writer lock.
		const jobs = createWorkerHostJobs({
			files: workerHostFiles(database),
			hostKind: "box-worker",
		});
		expect((await jobs.leases?.())?.length).toBe(2);
	});

	it("answers no leases before the worker has made its journal", async () => {
		const dir = await freshDir();
		const jobs = createWorkerHostJobs({
			files: workerHostFiles(join(dir, "worker.sqlite")),
			hostKind: "box-worker",
		});
		expect(await jobs.leases?.()).toEqual([]);
		expect(existsSync(join(dir, "worker.sqlite"))).toBe(false);
	});

	it("reads back the advert the worker wrote, and nothing from a missing or corrupt file", async () => {
		const dir = await freshDir();
		const files = workerHostFiles(join(dir, "worker.sqlite"));
		const jobs = createWorkerHostJobs({ files, hostKind: "mesh-node" });
		expect(await jobs.meshAdvert?.()).toBeUndefined();
		await writeWorkerMeshAdvert(files, advert);
		expect(await jobs.meshAdvert?.()).toMatchObject(advert);
		await writeFile(files.meshAdvert, "{not json");
		expect(await jobs.meshAdvert?.()).toBeUndefined();
	});

	it("closes and reopens admission with the marker the worker honours", async () => {
		const dir = await freshDir();
		const files = workerHostFiles(join(dir, "worker.sqlite"));
		const jobs = createWorkerHostJobs({ files, hostKind: "box-worker" });
		expect(workerAdmissionPaused(files)).toBe(false);
		await jobs.pauseAdmission?.();
		expect(workerAdmissionPaused(files)).toBe(true);
		expect(await readFile(files.admissionPaused, "utf8")).toBe("");
		await jobs.pauseAdmission?.();
		await jobs.resumeAdmission?.();
		expect(workerAdmissionPaused(files)).toBe(false);
		// Reopening an open gate is a no-op.
		await jobs.resumeAdmission?.();
		expect(workerAdmissionPaused(files)).toBe(false);
	});

	it("wires every job port for JIT hosts and refuses a local runner's presence by name", () => {
		const files = workerHostFiles("/var/lib/hobo-ci/worker.sqlite");
		for (const hostKind of ["box-worker", "mesh-node"] as const)
			expect(
				runnerHostInterfaceGaps({
					jobs: createWorkerHostJobs({ files, hostKind }),
				}).filter((gap) => gap.startsWith("jobs.")),
			).toEqual([]);
		expect(
			runnerHostInterfaceGaps({
				jobs: createWorkerHostJobs({ files, hostKind: "local-runner" }),
			}).filter((gap) => gap.startsWith("jobs.")),
		).toEqual(["jobs.runners"]);
	});
});
