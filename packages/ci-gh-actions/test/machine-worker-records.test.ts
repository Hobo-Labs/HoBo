import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MachineWorkerRecordRejection,
	machineWorkerEventJson,
	parseStoredMachine,
	parseWorkerEvent,
	WORKER_EVENT_TYPES,
	workerEvent,
} from "../src/machine-worker/records.js";
import { loadMachine, MACHINE_FILE } from "../src/machine-worker/session.js";

const FIXTURES = new URL(
	"../data-models/fixtures/machine_worker/",
	import.meta.url,
);
const fixtures = (kind: "valid" | "invalid") =>
	readdirSync(new URL(`${kind}/`, FIXTURES)).sort();
const fixture = (kind: "valid" | "invalid", name: string) =>
	readFileSync(new URL(`${kind}/${name}`, FIXTURES), "utf8");
const parse = (name: string, text: string) =>
	name.startsWith("stored-machine")
		? parseStoredMachine(text)
		: parseWorkerEvent(text);

describe("the machine worker's records", () => {
	it("reads every valid fixture into a frozen record", () => {
		expect(fixtures("valid").length).toBeGreaterThanOrEqual(7);
		for (const name of fixtures("valid")) {
			const record = parse(name, fixture("valid", name));
			expect(Object.isFrozen(record), name).toBe(true);
		}
	});

	it("refuses every invalid fixture", () => {
		for (const name of fixtures("invalid"))
			expect(() => parse(name, fixture("invalid", name)), name).toThrowError(
				MachineWorkerRecordRejection,
			);
	});

	it("prints each worker event as the line it parses back from", () => {
		const advertised = workerEvent({
			type: "worker.advertised",
			machineId: "m-7f3a",
			atMs: 1,
			busy: 0,
			slots: 1,
			paused: false,
		});
		const events = [
			advertised,
			workerEvent({
				type: "worker.job_failed",
				machineId: "m-7f3a",
				atMs: 2,
				jobId: 70,
				repository: "octo/app",
				detail: "No runner was made.",
			}),
		];
		for (const event of events) {
			const line = machineWorkerEventJson(event);
			expect(line).not.toContain("$typeName");
			expect(parseWorkerEvent(line)).toEqual(event);
		}
		expect(JSON.parse(machineWorkerEventJson(advertised))).toEqual({
			type: "worker.advertised",
			machineId: "m-7f3a",
			atMs: 1,
			busy: 0,
			slots: 1,
			paused: false,
		});
	});

	it("never makes an event with another type's fields", () => {
		expect(WORKER_EVENT_TYPES).toContain("worker.handing_off");
		expect(() =>
			workerEvent({
				type: "worker.job_refused",
				machineId: "m-7f3a",
				atMs: 1,
				jobId: 80,
				repository: "octo/site",
				runner: "hobo-machine-m-7f3a-80",
				detail: "refused",
			}),
		).toThrowError(/never has runner/u);
		expect(() =>
			workerEvent({ type: "worker.draining", machineId: "m-7f3a", atMs: 1 }),
		).toThrowError(/worker.draining needs/u);
	});

	it("writes machine.json as a StoredMachine and reads only that back", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-machine-record-"));
		const made = await loadMachine(directory, {
			name: undefined,
			defaultName: "studio",
		});
		const text = await readFile(join(directory, MACHINE_FILE), "utf8");
		expect(parseStoredMachine(text)).toMatchObject({
			id: made.id,
			name: "studio",
		});
		await writeFile(
			join(directory, MACHINE_FILE),
			JSON.stringify({ id: made.id, name: "studio", token: "gho_fixture" }),
		);
		await expect(
			loadMachine(directory, { name: undefined, defaultName: "studio" }),
		).rejects.toThrow(/is not a machine HoBo CI wrote/u);
	});
});
