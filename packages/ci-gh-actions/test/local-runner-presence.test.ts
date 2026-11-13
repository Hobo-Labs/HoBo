// A local runner's GitHub presence, as its controller writes it for the
// host's CD agent (`runner-presence.json` beside its other state): online only
// when GitHub said so, busy also from what the machine sees itself, and
// nothing once no runner is registered. Offline: a recorded GitHub response.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLocalRunnerPresenceReporter,
	type LocalRunnerApiResponse,
} from "../src/local-runner.js";
import {
	createWorkerHostJobs,
	workerHostFiles,
} from "../src/runner-host-worker-jobs.js";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

/** GitHub's `GET /repos/{repo}/actions/runners/{id}` for a waiting runner, recorded. */
const RECORDED_RUNNER = {
	id: 42,
	name: "hobo-local-0f8fad5b",
	os: "Linux",
	status: "online",
	busy: false,
	labels: [{ id: 1, name: "hobo-local-host", type: "custom" }],
};

describe("local runner presence for the runner-host agent", () => {
	it("writes GitHub's presence of its registered runner, and none after the session", async () => {
		const state = await mkdtemp(join(tmpdir(), "local-runner-presence-"));
		dirs.push(state);
		const files = workerHostFiles(join(state, "worker.sqlite"));
		const work = join(state, "host-1");
		await mkdir(work);
		const asked: string[] = [];
		let nowMs = 5_000_000;
		const reporter = createLocalRunnerPresenceReporter({
			files,
			repository: "hobo-labs/private-app",
			now: () => nowMs,
			api: async (method, path): Promise<LocalRunnerApiResponse> => {
				asked.push(`${method} ${path}`);
				return { ...RECORDED_RUNNER, status: "online", busy: false };
			},
		});
		const jobs = createWorkerHostJobs({
			files,
			hostKind: "local-runner",
			now: () => nowMs,
		});
		reporter.observer.waiting(work, { id: 42, name: RECORDED_RUNNER.name });
		await reporter.refresh();
		expect(asked.at(-1)).toBe(
			"GET /repos/hobo-labs/private-app/actions/runners/42",
		);
		expect(await jobs.runners()).toEqual([
			{
				name: RECORDED_RUNNER.name,
				presence: { status: "online", busy: false },
			},
		]);

		// The machine sees a job start before GitHub says busy: busy anyway.
		await mkdir(join(work, "_diag"));
		await writeFile(join(work, "_diag", "Worker_20261113-100000-utc.log"), "");
		nowMs += 1_000;
		await reporter.refresh();
		expect((await jobs.runners())[0]?.presence.busy).toBe(true);

		reporter.observer.ended("delivered");
		await reporter.refresh();
		expect(await jobs.runners()).toEqual([]);
		expect(
			JSON.parse(readFileSync(files.runnerPresence, "utf8")).runners,
		).toEqual([]);
	});

	it("reports the runner offline, never online, when GitHub cannot be asked", async () => {
		const state = await mkdtemp(join(tmpdir(), "local-runner-presence-"));
		dirs.push(state);
		const files = workerHostFiles(join(state, "worker.sqlite"));
		const reporter = createLocalRunnerPresenceReporter({
			files,
			repository: "hobo-labs/private-app",
			api: async () => {
				throw new Error("GitHub runner API failed");
			},
		});
		reporter.observer.waiting(join(state, "missing"), { id: 7, name: "r" });
		expect(await reporter.presence()).toMatchObject({
			runners: [{ name: "r", status: "offline", busy: false }],
		});
	});
});
