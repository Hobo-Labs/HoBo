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
	CONTROLLER_DESIRED_FILE,
	CONTROLLER_RELEASES_DIR,
	CONTROLLER_STATUS_FILE,
	controllerDigestFromEnv,
	createWorkerHostJobs,
	readWorkerLeases,
	WORKER_ADMISSION_PAUSED_FILE,
	WORKER_MESH_ADVERT_FILE,
	WORKER_RUNNER_PRESENCE_FILE,
	workerAdmissionPaused,
	workerHostFiles,
	writeWorkerMeshAdvert,
	writeWorkerRunnerPresence,
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
			runnerPresence: `/var/lib/hobo-ci/${WORKER_RUNNER_PRESENCE_FILE}`,
			controllerDesired: `/var/lib/hobo-ci/${CONTROLLER_DESIRED_FILE}`,
			controllerStatus: `/var/lib/hobo-ci/${CONTROLLER_STATUS_FILE}`,
			controllerReleases: `/var/lib/hobo-ci/${CONTROLLER_RELEASES_DIR}`,
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

	it("carries the controller digest a supervised worker names, beside the advert", async () => {
		const dir = await freshDir();
		const files = workerHostFiles(join(dir, "worker.sqlite"));
		const jobs = createWorkerHostJobs({ files, hostKind: "box-worker" });
		const digest = `sha256:${"a".repeat(64)}`;
		expect(controllerDigestFromEnv({ HOBO_CI_CONTROLLER_DIGEST: digest })).toBe(
			digest,
		);
		expect(
			controllerDigestFromEnv({ HOBO_CI_CONTROLLER_DIGEST: "latest" }),
		).toBeUndefined();
		await writeWorkerMeshAdvert(files, advert);
		const plain = await jobs.meshAdvert();
		expect(plain?.controllerDigest).toBeUndefined();
		await writeWorkerMeshAdvert(files, advert, digest);
		expect(await jobs.meshAdvert()).toEqual({
			...plain,
			controllerDigest: digest,
		});
		// An invalid digest is never written.
		await writeWorkerMeshAdvert(files, advert, "sha256:nope");
		expect((await jobs.meshAdvert())?.controllerDigest).toBeUndefined();
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

	it("wires every job port for every host kind, a local runner included", () => {
		const files = workerHostFiles("/var/lib/hobo-ci/worker.sqlite");
		for (const hostKind of ["box-worker", "mesh-node", "local-runner"] as const)
			expect(
				runnerHostInterfaceGaps({
					jobs: createWorkerHostJobs({ files, hostKind }),
				}).filter((gap) => gap.startsWith("jobs.")),
			).toEqual([]);
	});

	it("reads a local runner's GitHub presence while its report is fresh, and none when it is not", async () => {
		const dir = await freshDir();
		const files = workerHostFiles(join(dir, "worker.sqlite"));
		let nowMs = 1_000_000;
		const local = createWorkerHostJobs({
			files,
			hostKind: "local-runner",
			now: () => nowMs,
		});
		// No report yet: no runner, never an assumed online one.
		expect(await local.runners()).toEqual([]);
		await writeWorkerRunnerPresence(files, {
			observedAtMs: nowMs - 30_000,
			runners: [{ name: "hobo-local-1", status: "online", busy: true }],
		});
		const runners = await local.runners();
		expect(runners).toEqual([
			{ name: "hobo-local-1", presence: { status: "online", busy: true } },
		]);
		expect(inFlightJobCount([], runners)).toBe(1);
		// A JIT host's runners are counted by lease, never from this file.
		expect(
			await createWorkerHostJobs({ files, hostKind: "box-worker" }).runners(),
		).toEqual([]);
		// Stale (the controller stopped refreshing) or corrupt: no runner.
		nowMs += 5 * 60_000;
		expect(await local.runners()).toEqual([]);
		nowMs -= 5 * 60_000;
		await writeFile(files.runnerPresence, "{not json");
		expect(await local.runners()).toEqual([]);
	});
});
