import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GithubTransport } from "../src/github.js";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import {
	createGithubJobPoller,
	createPollLogFilter,
	describeWaitingJobs,
	type GithubJobPollSummary,
	type GithubReadFailure,
} from "../src/isolated-worker/github-job-poller.js";
import {
	createWorkerMemoryAdmission,
	type WorkerMemoryAdmission,
} from "../src/isolated-worker/memory-admission.js";
import { resolveWorkerMemoryConfig } from "../src/isolated-worker/memory-classes.js";
import type { WorkerStorageAdmission } from "../src/isolated-worker/storage-admission.js";
import { createJobDurations, type JobDurations } from "../src/job-durations.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const REPO = "Org/Repo";
const CONNECTION = { installationId: 10, repositoryId: 101, repository: REPO };

const PolledBody = z
	.object({
		action: z.string(),
		installation: z.object({ id: z.number() }).strict(),
		repository: z.object({ id: z.number(), full_name: z.string() }).strict(),
		workflow_job: z
			.object({
				id: z.number(),
				run_id: z.number(),
				run_attempt: z.number(),
				labels: z.array(z.string()),
				name: z.string().optional(),
				runner_name: z.string().nullable(),
			})
			.strict(),
	})
	.strict();

interface FakeJob {
	id: number;
	status: string;
	labels: string[];
	runner_name?: string | null;
	name?: string;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
}

/** Answers only the REST reads the poller and relay make; anything else is a contract violation. */
class FakeGithub implements GithubTransport {
	calls: string[] = [];
	/** Calls GitHub would count against the rate limit (everything but a 304). */
	counted: string[] = [];
	limited = false;
	/** Paths answered 502, as GitHub does now and then. */
	failing = new Set<string>();
	/** Run attempt per run id; 1 when absent. */
	attempts = new Map<number, number>();
	/** Event and start time per run id; a pull request that has not started when absent. */
	started = new Map<number, { event: string; at: string }>();
	constructor(
		readonly runs: Record<"queued" | "in_progress", number[]> & {
			completed?: number[];
			/** Queued, but missing from `?status=queued` (run 41622562414). */
			unlisted?: number[];
		},
		readonly jobs: Record<number, FakeJob[]>,
	) {}
	async request(
		installationId: number,
		path: string,
		method = "GET",
		_body?: string,
		ifNoneMatch?: string,
	) {
		const response = await this.answer(installationId, path, method);
		const etag = `W/"${createHash("sha256")
			.update(await response.clone().text())
			.digest("hex")
			.slice(0, 16)}"`;
		if (response.ok && ifNoneMatch === etag)
			return new Response(null, {
				status: 304,
				headers: { etag, "x-ratelimit-remaining": "4000" },
			});
		this.counted.push(`${method} ${path}`);
		const headers = new Headers(response.headers);
		if (response.ok) headers.set("etag", etag);
		return new Response(response.body, { status: response.status, headers });
	}
	private attempt(runId: number): number {
		return this.attempts.get(runId) ?? 1;
	}
	private async answer(installationId: number, path: string, method: string) {
		this.calls.push(`${method} ${path}`);
		if (installationId !== 10 || method !== "GET")
			throw new Error(`unexpected ${method} ${path}`);
		if (this.limited)
			return new Response("{}", {
				status: 403,
				headers: {
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": String(NOW / 1000 + 120),
				},
			});
		const headers = { "x-ratelimit-remaining": "4000" };
		if (this.failing.has(path))
			return new Response('{"message":"Server Error"}', {
				status: 502,
				headers,
			});
		if (path === "/repos/Org/Repo/actions/runs?per_page=50") {
			const listed = (ids: number[] | undefined, status: string) =>
				(ids ?? []).map((id) => ({
					id,
					run_attempt: this.attempt(id),
					status,
					event: this.started.get(id)?.event ?? "pull_request",
					run_started_at: this.started.get(id)?.at ?? null,
				}));
			return Response.json(
				{
					workflow_runs: [
						...listed(this.runs.unlisted, "queued"),
						...listed(this.runs.queued, "queued"),
						...listed(this.runs.in_progress, "in_progress"),
						...listed(this.runs.completed, "completed"),
					],
				},
				{ headers },
			);
		}
		const list =
			/^\/repos\/Org\/Repo\/actions\/runs\?status=(queued|in_progress)&per_page=50$/.exec(
				path,
			);
		if (list?.[1] === "queued" || list?.[1] === "in_progress")
			return Response.json(
				{
					workflow_runs: this.runs[list[1]].map((id) => ({
						id,
						run_attempt: this.attempt(id),
					})),
				},
				{ headers },
			);
		if (
			/^\/repos\/Org\/Repo\/actions\/runs\?status=completed&created=%3E%3D[0-9T:.Z-]+&per_page=50$/.test(
				path,
			)
		) {
			return Response.json(
				{
					workflow_runs: (this.runs.completed ?? []).map((id) => ({
						id,
						run_attempt: this.attempt(id),
					})),
				},
				{ headers },
			);
		}
		const runJobs =
			/^\/repos\/Org\/Repo\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(
				path,
			);
		if (runJobs?.[1]) {
			const runId = Number(runJobs[1]);
			return Response.json(
				{
					jobs: (this.jobs[runId] ?? []).map((job) => ({
						...job,
						run_id: runId,
						run_attempt: this.attempt(runId),
					})),
				},
				{ headers },
			);
		}
		const run = /^\/repos\/Org\/Repo\/actions\/runs\/(\d+)$/.exec(path);
		if (run?.[1])
			return Response.json({
				id: Number(run[1]),
				run_attempt: 1,
				event: this.started.get(Number(run[1]))?.event ?? "pull_request",
				head_sha: "a".repeat(40),
				head_branch: "feature",
				path: ".github/workflows/ci.yml",
				display_title: "CI",
				status: "queued",
				conclusion: null,
				run_started_at: this.started.get(Number(run[1]))?.at ?? null,
				updated_at: "2026-11-02T12:00:00Z",
				actor: { id: 7 },
				repository: { id: 101, private: false },
				head_repository: { id: 101 },
			});
		const job = /^\/repos\/Org\/Repo\/actions\/jobs\/(\d+)$/.exec(path);
		if (job?.[1]) {
			const id = Number(job[1]);
			const [runId, found] =
				Object.entries(this.jobs)
					.flatMap(([runId, jobs]) =>
						jobs.map((entry) => [Number(runId), entry] as const),
					)
					.find(([, entry]) => entry.id === id) ?? [];
			if (!found || !runId) return new Response("{}", { status: 404 });
			return Response.json({
				...found,
				run_id: runId,
				run_attempt: 1,
			});
		}
		throw new Error(`unexpected ${method} ${path}`);
	}
}

describe("GitHub job poller", () => {
	it("turns runs-on: hobo jobs into one durable delivery per job state", async () => {
		const github = new FakeGithub(
			{ queued: [900], in_progress: [901] },
			{
				900: [{ id: 1, status: "queued", labels: ["hobo"] }],
				901: [
					{
						id: 2,
						status: "in_progress",
						labels: ["hobo"],
						runner_name: "hobo-r2",
					},
					{ id: 3, status: "in_progress", labels: ["hobo"], runner_name: null },
					{ id: 4, status: "queued", labels: ["ubuntu-latest"] },
					{ id: 5, status: "queued", labels: ["hobo", "large"] },
					{
						id: 6,
						status: "completed",
						labels: ["HoBo"],
						runner_name: "hobo-r6",
					},
				],
			},
		);
		const seen = new Set<string>();
		const bodies: Record<string, z.infer<typeof PolledBody>> = {};
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION, CONNECTION],
			ingest: async (delivery) => {
				bodies[delivery.deliveryId] = PolledBody.parse(
					JSON.parse(Buffer.from(delivery.rawBody).toString()),
				);
				if (seen.has(delivery.deliveryId)) return "duplicate";
				seen.add(delivery.deliveryId);
				return "accepted";
			},
			now: () => NOW,
		});
		expect(await poller.poll()).toEqual({
			repositories: 1,
			runs: 2,
			hoboJobs: 3,
			accepted: 3,
			failed: 0,
			settled: 0,
			notModified: 0,
			githubErrors: 0,
			waiting: [],
			rateLimitRemaining: 4000,
		});
		const ids = Object.keys(bodies).sort();
		expect(ids).toEqual([
			"poll-1-1-q",
			expect.stringMatching(/^poll-2-1-p-[0-9a-f]{12}$/),
			expect.stringMatching(/^poll-6-1-c-[0-9a-f]{12}$/),
		]);
		expect(bodies[ids[1] ?? ""]).toEqual({
			action: "in_progress",
			installation: { id: 10 },
			repository: { id: 101, full_name: REPO },
			workflow_job: {
				id: 2,
				run_id: 901,
				run_attempt: 1,
				labels: ["hobo"],
				runner_name: "hobo-r2",
			},
		});
		expect((await poller.poll()).accepted).toBe(0);
	});

	it("counts a requeued job as accepted rather than waiting", async () => {
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 1, status: "queued", labels: ["hobo"] }] },
		);
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async () => "requeued",
			now: () => NOW,
		});
		expect(await poller.poll()).toMatchObject({ accepted: 1, waiting: [] });
	});

	it("sees the last job of a run that already finished, so its runner is reaped", async () => {
		const github = new FakeGithub(
			{ queued: [], in_progress: [], completed: [902] },
			{
				902: [
					{
						id: 7,
						status: "completed",
						labels: ["hobo"],
						runner_name: "hobo-r7",
					},
				],
			},
		);
		const ids: string[] = [];
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async (delivery) => {
				ids.push(delivery.deliveryId);
				return "accepted";
			},
			now: () => NOW,
		});
		expect(await poller.poll()).toMatchObject({
			runs: 1,
			hoboJobs: 1,
			accepted: 1,
		});
		expect(ids).toEqual([expect.stringMatching(/^poll-7-1-c-[0-9a-f]{12}$/)]);
	});

	it("re-reads unchanged lists conditionally, so an idle poll costs no rate limit", async () => {
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 1, status: "queued", labels: ["hobo"] }] },
		);
		let clock = NOW;
		const ids: string[] = [];
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async (delivery) => {
				ids.push(delivery.deliveryId);
				return ids.indexOf(delivery.deliveryId) === ids.length - 1
					? "accepted"
					: "duplicate";
			},
			now: () => clock,
		});
		await poller.poll();
		expect(github.counted).toHaveLength(5);
		github.counted = [];
		clock += 15_000;
		// A 304 still hands the cached body on, so the job is observed again.
		expect(await poller.poll()).toMatchObject({
			hoboJobs: 1,
			accepted: 0,
			notModified: 5,
		});
		expect(github.counted).toEqual([]);
		expect(ids).toEqual(["poll-1-1-q", "poll-1-1-q"]);
		// A changed list is a 200 again, and only that read is counted.
		github.jobs[900]?.push({ id: 2, status: "queued", labels: ["hobo"] });
		expect(await poller.poll()).toMatchObject({ accepted: 1, notModified: 4 });
		expect(github.counted).toEqual([
			"GET /repos/Org/Repo/actions/runs/900/jobs?filter=latest&per_page=100",
		]);
	});

	it("keeps the completed-runs URL still between polls in one ten-minute step", async () => {
		const github = new FakeGithub({ queued: [], in_progress: [] }, {});
		let clock = Date.parse("2026-11-02T12:00:30Z");
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async () => "accepted",
			now: () => clock,
		});
		const completedReads = () =>
			github.calls.filter((call) => call.includes("status=completed"));
		await poller.poll();
		clock += 9 * 60_000;
		await poller.poll();
		clock += 60_000;
		await poller.poll();
		expect(completedReads()).toEqual([
			expect.stringContaining("created=%3E%3D2026-11-02T10:00:00.000Z&"),
			expect.stringContaining("created=%3E%3D2026-11-02T10:00:00.000Z&"),
			expect.stringContaining("created=%3E%3D2026-11-02T10:10:00.000Z&"),
		]);
	});

	it("reads a completed run's jobs until they are all seen completed, then not again until a re-run", async () => {
		const github = new FakeGithub(
			{ queued: [], in_progress: [], completed: [902, 903, 904] },
			{
				902: [
					{ id: 7, status: "completed", labels: ["hobo"], runner_name: "r7" },
					{ id: 8, status: "completed", labels: ["ubuntu-latest"] },
				],
				// GitHub can list a run as completed while a job still reads in_progress.
				903: [
					{ id: 9, status: "in_progress", labels: ["hobo"], runner_name: "r9" },
				],
				904: [
					{ id: 10, status: "completed", labels: ["hobo"], runner_name: "r10" },
				],
			},
		);
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async (delivery) => {
				if (delivery.deliveryId.startsWith("poll-10-1-"))
					throw new Error("inbox full");
				return "accepted";
			},
			now: () => NOW,
		});
		const jobReads = () =>
			github.calls
				.filter((call) => call.includes("/jobs?"))
				.map((call) => Number(/runs\/(\d+)\/jobs/.exec(call)?.[1]));
		expect(await poller.poll()).toMatchObject({ runs: 3, settled: 0 });
		expect(jobReads()).toEqual([902, 903, 904]);
		github.calls = [];
		// 902 is settled; 903 had a job not yet completed; 904's job was refused.
		expect(await poller.poll()).toMatchObject({ runs: 2, settled: 1 });
		expect(jobReads()).toEqual([903, 904]);
		github.calls = [];
		// A re-run is a new attempt, read again while it runs and once it completes.
		github.attempts.set(902, 2);
		github.runs.in_progress.push(902);
		github.runs.completed = [903, 904];
		await poller.poll();
		expect(jobReads()).toEqual([902, 903, 904]);
		github.calls = [];
		github.runs.in_progress = [];
		github.runs.completed = [902];
		expect(await poller.poll()).toMatchObject({ runs: 1, settled: 0 });
		expect(jobReads()).toEqual([902]);
		github.calls = [];
		expect(await poller.poll()).toMatchObject({ runs: 0, settled: 1 });
		expect(jobReads()).toEqual([]);
	});

	it("pauses until the rate-limit reset instead of hammering GitHub", async () => {
		const github = new FakeGithub({ queued: [], in_progress: [] }, {});
		github.limited = true;
		let clock = NOW;
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async () => "accepted",
			now: () => clock,
		});
		const first = await poller.poll();
		expect(first.pausedUntil).toBe(new Date(NOW + 120_000).toISOString());
		const calls = github.calls.length;
		clock += 60_000;
		await poller.poll();
		expect(github.calls.length).toBe(calls);
		github.limited = false;
		clock += 61_000;
		expect((await poller.poll()).pausedUntil).toBe(undefined);
		expect(github.calls.length).toBeGreaterThan(calls);
	});

	it("treats a runner (re)assignment as a new delivery and keeps polling past a refused job", async () => {
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{
				900: [
					{ id: 1, status: "queued", labels: ["hobo"], runner_name: null },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		const fingerprints = new Map<string, string>();
		const errors: number[] = [];
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			// Same contract as the stores: one delivery id, one body.
			ingest: async ({ deliveryId, rawBody }) => {
				const body = Buffer.from(rawBody).toString();
				if (deliveryId === "poll-2-1-q") throw new Error("inbox full");
				const known = fingerprints.get(deliveryId);
				if (known !== undefined && known !== body)
					throw new Error("conflicting webhook delivery id");
				fingerprints.set(deliveryId, body);
				return known === undefined ? "accepted" : "duplicate";
			},
			onIngestError: (jobId) => errors.push(jobId),
			now: () => NOW,
		});
		expect(await poller.poll()).toMatchObject({ accepted: 1, failed: 1 });
		const [job1] = github.jobs[900] ?? [];
		// GitHub flips an unassigned runner_name between null and "".
		if (job1) job1.runner_name = "";
		expect(await poller.poll()).toMatchObject({ accepted: 0, failed: 1 });
		if (job1) job1.runner_name = "hobo-a742da4d";
		expect(await poller.poll()).toMatchObject({ accepted: 1, failed: 1 });
		expect(errors).toEqual([2, 2, 2]);
		expect([...fingerprints.keys()]).toEqual([
			"poll-1-1-q",
			expect.stringMatching(/^poll-1-1-q-[0-9a-f]{12}$/),
		]);
	});

	it("reports the GitHub reads it could not make and the queued jobs it did not accept", async () => {
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{
				900: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
					{ id: 3, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.failing.add(
			"/repos/Org/Repo/actions/runs?status=in_progress&per_page=50",
		);
		const failures: GithubReadFailure[] = [];
		const results = new Map([
			["poll-1-1-q", "accepted"],
			["poll-2-1-q", "ignored"],
		]);
		const poller = createGithubJobPoller({
			github,
			connections: async () => [CONNECTION],
			ingest: async ({ deliveryId }) => {
				const result = results.get(deliveryId);
				if (result === undefined) throw new Error("inbox full");
				results.set(deliveryId, result === "accepted" ? "duplicate" : result);
				return result;
			},
			onGithubError: (failure) => failures.push(failure),
			now: () => NOW,
		});
		expect(await poller.poll()).toMatchObject({
			accepted: 1,
			failed: 1,
			githubErrors: 1,
			waiting: [
				{ jobId: 2, runId: 900, result: "ignored" },
				{ jobId: 3, runId: 900, result: "failed" },
			],
		});
		expect(failures).toEqual([
			{
				installationId: 10,
				path: "/repos/Org/Repo/actions/runs?status=in_progress&per_page=50",
				status: 502,
			},
		]);
		github.failing.clear();
		const second = await poller.poll();
		expect(second).toMatchObject({ accepted: 0, githubErrors: 0 });
		expect(describeWaitingJobs(second.waiting)).toBe(
			"900/1:duplicate,900/2:ignored,900/3:failed",
		);
	});

	it("logs a poll that admitted, failed or left jobs waiting, and stays quiet when idle", () => {
		const worth = createPollLogFilter(60_000);
		const poll = (fields: Partial<GithubJobPollSummary> = {}) => ({
			repositories: 1,
			runs: 0,
			hoboJobs: 0,
			accepted: 0,
			failed: 0,
			settled: 0,
			notModified: 5,
			githubErrors: 0,
			waiting: [],
			...fields,
		});
		const stuck = [{ jobId: 1, runId: 900, result: "duplicate" }];
		expect(worth(poll(), NOW)).toBe(false);
		expect(worth(poll({ githubErrors: 1 }), NOW + 15_000)).toBe(true);
		expect(worth(poll({ accepted: 1 }), NOW + 30_000)).toBe(true);
		expect(worth(poll({ waiting: stuck }), NOW + 45_000)).toBe(true);
		// The same job still waiting is repeated once a minute, not every poll.
		expect(worth(poll({ waiting: stuck }), NOW + 60_000)).toBe(false);
		expect(worth(poll({ waiting: stuck }), NOW + 105_000)).toBe(true);
		expect(worth(poll(), NOW + 120_000)).toBe(true);
		expect(worth(poll(), NOW + 135_000)).toBe(false);
	});
});

describe("pull-mode box worker over SQLite", () => {
	let root = "";
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "hobo-ci-pull-"));
	});
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function configuredStore(
		concurrency: number,
		path = join(root, `${randomUUID()}.sqlite`),
	) {
		const store = new SqliteCiStore(path);
		await store.configure(
			create(ConfigurationSchema, {
				accounts: [
					create(AccountSchema, {
						id: "hobo-labs",
						maxRuntimeMinutes: 30,
						startupMinutes: 5,
						offers: [
							create(OfferSchema, {
								id: "box-isolated",
								provider: "kubernetes",
								providerAccountId: "box",
								enabled: true,
								runsOn: "hobo-isolated-worker",
								backend: "isolated-container",
								concurrency,
								observedAt: "2026-11-02T00:00:00Z",
								validUntil: "2026-12-31T23:59:59Z",
								sourceUrl: "https://example.test/box-evidence",
								bridgeAcknowledged: true,
							}),
						],
					}),
				],
				connections: [
					create(ConnectionSchema, {
						accountId: "hobo-labs",
						...CONNECTION,
						runnerGroupId: 1,
						isolatedOnly: true,
						acceptAllMatchingRepositoryJobs: true,
						trustedRepositoryAcknowledged: true,
						publicRepositoryAcknowledged: true,
					}),
				],
			}),
			0,
			new Date(NOW).toISOString(),
		);
		return store;
	}

	function boxRuntime(
		store: SqliteCiStore,
		github: GithubTransport,
		launched: string[],
		jobDurations?: JobDurations,
		trunk?: {
			generalLeaseLimit?: number;
			mergeGroupLeaseLimit?: number;
			lendTrunkSlots?: boolean;
			skipLaunchFor?: readonly number[];
			memoryAdmission?: WorkerMemoryAdmission;
			storageAdmission?: WorkerStorageAdmission;
			labels: Map<string, string | undefined>;
		},
	) {
		const options: Parameters<typeof createHostedRelayRuntime>[0] = {
			store,
			github,
			identity: {
				async verify() {
					throw new Error("pull mode never verifies OIDC");
				},
			},
			webhookSecret: randomUUID() + randomUUID(),
			isolatedHost: {
				async launch(id, label) {
					const lease = await store.get(id);
					const skipped = trunk?.skipLaunchFor?.includes(lease?.jobId ?? 0);
					if (!lease || lease.sandboxName || skipped) return;
					launched.push(id);
					trunk?.labels.set(id, label);
					await store.transition(
						id,
						["reserved"],
						(entry) => {
							entry.sandboxName = `hobo-${id}`;
							entry.sandboxStage = "creating";
						},
						"ci.DispatchRequested",
						new Date(NOW).toISOString(),
					);
				},
				async reconcile() {},
			},
			denyUnisolated: true,
			control: async () => undefined,
			now: () => new Date(NOW).toISOString(),
		};
		if (jobDurations) options.jobDurations = jobDurations;
		if (trunk?.generalLeaseLimit !== undefined)
			options.generalLeaseLimit = trunk.generalLeaseLimit;
		if (trunk?.mergeGroupLeaseLimit !== undefined)
			options.mergeGroupLeaseLimit = trunk.mergeGroupLeaseLimit;
		if (trunk?.lendTrunkSlots !== undefined)
			options.lendTrunkSlots = trunk.lendTrunkSlots;
		if (trunk?.memoryAdmission) options.memoryAdmission = trunk.memoryAdmission;
		if (trunk?.storageAdmission)
			options.storageAdmission = trunk.storageAdmission;
		return createHostedRelayRuntime(options);
	}

	function memoryJob(id: number, name: string, labels = ["hobo"]) {
		return create(JobSchema, {
			id,
			runId: 900 + id,
			runAttempt: 1,
			repositoryId: CONNECTION.repositoryId,
			installationId: CONNECTION.installationId,
			repository: REPO,
			labels,
			name,
			action: "queued",
			isolatedRequired: true,
		});
	}

	function memoryGithub(jobs: readonly ReturnType<typeof memoryJob>[]) {
		return new FakeGithub(
			{ queued: [], in_progress: [] },
			Object.fromEntries(
				jobs.map((job) => [
					job.runId,
					[
						{
							id: job.id,
							status: "queued",
							labels: [...job.labels],
							name: job.name,
						},
					],
				]),
			),
		);
	}
	it("caps merge groups without blocking a push, then admits the waiter in order", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = await configuredStore(3);
		const github = new FakeGithub(
			{ queued: [900, 901, 902], in_progress: [] },
			{
				900: [{ id: 1, status: "queued", labels: ["hobo-trunk"] }],
				901: [{ id: 2, status: "queued", labels: ["hobo-trunk"] }],
				902: [{ id: 3, status: "queued", labels: ["hobo-trunk"] }],
			},
		);
		github.started.set(900, {
			event: "merge_group",
			at: "2026-11-02T11:55:00Z",
		});
		github.started.set(901, {
			event: "merge_group",
			at: "2026-11-02T11:56:00Z",
		});
		github.started.set(902, {
			event: "push",
			at: "2026-11-02T11:57:00Z",
		});
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels: new Map(),
			generalLeaseLimit: 2,
			mergeGroupLeaseLimit: 1,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });

		const initial = await store.activeLeases();
		expect(initial.map((lease) => lease.jobId).sort()).toEqual([1, 3]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2]);
		const first = initial.find((lease) => lease.jobId === 1);
		if (!first) throw new Error("first merge-group lease missing");
		for (const lease of initial)
			await store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
				},
				"ci.RunnerRegistered",
				new Date(NOW).toISOString(),
			);

		github.calls.length = 0;
		await runtime.tick({ maxDeliveries: 10 });
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2]);
		expect(
			github.calls.filter((call) =>
				/^GET \/repos\/Org\/Repo\/actions\/runs\/\d+$/u.test(call),
			),
		).toEqual([]);
		const waitLogs = () =>
			log.mock.calls.filter(([line]) =>
				line.includes("hobo_ci_merge_group_cap_wait"),
			);
		expect(waitLogs()).toHaveLength(1);
		expect(waitLogs()[0]?.[0]).toContain('"jobId":2');

		await store.transition(
			first.id,
			["running"],
			(lease) => {
				lease.state = "completed";
			},
			"ci.LeaseCompleted",
			new Date(NOW).toISOString(),
		);
		await runtime.tick({ maxDeliveries: 10 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([2, 3]);
		expect(launched).toHaveLength(3);
		expect(waitLogs()).toHaveLength(1);
		log.mockRestore();
		store.close();
	});

	it("blocks a pull request while a merge group waits for its lease cap", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = await configuredStore(2);
		const first = memoryJob(1, "PR impact gate", ["hobo-trunk"]);
		const waiting = memoryJob(2, "PR impact gate", ["hobo-trunk"]);
		const pullRequest = memoryJob(3, "CI fabric contract guard");
		const github = memoryGithub([first, waiting, pullRequest]);
		for (const [job, at] of [
			[first, "2026-11-02T11:55:00Z"],
			[waiting, "2026-11-02T11:56:00Z"],
		] as const)
			github.started.set(job.runId, { event: "merge_group", at });
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			mergeGroupLeaseLimit: 1,
		});
		for (const job of [first, waiting, pullRequest])
			await store.queue(job, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect((await store.activeLeases()).map((lease) => lease.jobId)).toEqual([
			1,
		]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2, 3]);
		await runtime.tick({ maxDeliveries: 0 });
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2, 3]);
		const [lease] = await store.activeLeases();
		if (!lease) throw new Error("first merge-group lease missing");
		await store.settle(lease.id, 0, 1, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((entry) => entry.jobId).sort(),
		).toEqual([2, 3]);
		expect(await store.pendingJobs()).toEqual([]);
		log.mockRestore();
		store.close();
	});

	it("leaves a job queued while storage admission blocks and admits after recovery", async () => {
		const store = await configuredStore(1);
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 1, status: "queued", labels: ["hobo"] }] },
		);
		const launched: string[] = [];
		let allowed = false;
		const storageAdmission: WorkerStorageAdmission = {
			admit: vi.fn(async () => allowed),
		};
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels: new Map(),
			storageAdmission,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([1]);
		expect(await store.activeLeases()).toEqual([]);
		expect(launched).toEqual([]);
		allowed = true;
		await runtime.tick({ maxDeliveries: 10 });
		expect((await store.activeLeases()).map((lease) => lease.jobId)).toEqual([
			1,
		]);
		expect(launched).toHaveLength(1);
		store.close();
	});

	it("admits a polled queued job into a reserved box lease and launches it, with no relay or webhook", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 1, status: "queued", labels: ["hobo"] }] },
		);
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched);
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		expect((await poller.poll()).accepted).toBe(1);
		await runtime.tick({ maxDeliveries: 10 });
		const [lease] = await store.activeLeases();
		expect(lease).toMatchObject({
			provider: "kubernetes",
			jobId: 1,
			state: "reserved",
		});
		expect(launched).toEqual([lease?.id]);
		store.close();
	});

	it("persists the exact-name memory request across a store reload", async () => {
		const path = join(root, "memory-reload.sqlite");
		const store = await configuredStore(3, path);
		const github = new FakeGithub(
			{ queued: [901], in_progress: [] },
			{
				901: [
					{
						id: 2,
						status: "queued",
						labels: ["hobo"],
						name: "CI fabric contract guard",
					},
				],
			},
		);
		const memoryAdmission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "14336" },
				{ totalMemoryMb: 16_384, trunkSlots: 0 },
			),
			{ now: () => NOW },
		);
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			memoryAdmission,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const [lease] = await store.activeLeases();
		if (!lease) throw new Error("memory-classified lease missing");
		expect(lease).toMatchObject({ memoryClass: "light", memoryMb: 3_072 });
		store.close();
		const reopened = new SqliteCiStore(path);
		expect(await reopened.get(lease.id)).toMatchObject({
			memoryClass: "light",
			memoryMb: 3_072,
		});
		reopened.close();
	});

	it("queues heavy jobs over the memory budget and admits the next after settlement", async () => {
		const store = await configuredStore(3);
		const jobs = [1, 2, 3].map((id) => memoryJob(id, "PR impact gate"));
		const memoryAdmission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{
					HOBO_CI_WORKER_MEMORY_BUDGET_MB: "14336",
					HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB: "8192",
				},
				{ totalMemoryMb: 16_384, trunkSlots: 0 },
			),
			{ now: () => NOW },
		);
		const runtime = boxRuntime(store, memoryGithub(jobs), [], undefined, {
			labels: new Map(),
			memoryAdmission,
		});
		for (const job of jobs) await store.queue(job, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2, 3]);
		const [first] = await store.activeLeases();
		if (!first) throw new Error("first heavy lease missing");
		await store.settle(first.id, 0, 1, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([2]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([3]);
		store.close();
	});

	it("backfills light jobs before HOL timeout but not after it", async () => {
		const store = await configuredStore(3);
		const jobs = [
			memoryJob(1, "unclassified standard job"),
			memoryJob(2, "PR impact gate"),
			memoryJob(3, "CI fabric contract guard"),
		];
		let now = NOW;
		const memoryAdmission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{
					HOBO_CI_WORKER_MEMORY_BUDGET_MB: "8500",
					HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB: "3072",
					HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB: "5120",
					HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB: "4000",
				},
				{ totalMemoryMb: 16_384, trunkSlots: 0 },
			),
			{ now: () => now },
		);
		const github = memoryGithub(jobs);
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			memoryAdmission,
		});
		for (const job of jobs) await store.queue(job, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 3]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2]);
		const backfilled = (await store.activeLeases()).find(
			(lease) => lease.jobId === 3,
		);
		if (!backfilled) throw new Error("backfilled lease missing");
		await store.settle(backfilled.id, 0, 1, new Date(NOW).toISOString());
		const laterLight = memoryJob(4, "CI fabric contract guard");
		github.jobs[laterLight.runId] = [
			{
				id: laterLight.id,
				status: "queued",
				labels: laterLight.labels,
				name: laterLight.name,
			},
		];
		await store.queue(laterLight, new Date(NOW).toISOString());
		now += 60_001;
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2, 4]);
		store.close();
	});

	it("blocks lower ranks until a memory-waiting trunk job is admitted", async () => {
		const store = await configuredStore(3);
		const running = memoryJob(1, "PR impact gate");
		const trunk = memoryJob(2, "PR impact gate", ["hobo-trunk"]);
		const pullRequest = memoryJob(3, "CI fabric contract guard");
		let now = NOW;
		const memoryAdmission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "10000" },
				{ totalMemoryMb: 16_384, trunkSlots: 0 },
			),
			{ now: () => now },
		);
		const runtime = boxRuntime(
			store,
			memoryGithub([running, trunk, pullRequest]),
			[],
			undefined,
			{ labels: new Map(), memoryAdmission },
		);
		await store.queue(running, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		runtime.admissionOrder.prime({
			runId: trunk.runId,
			event: "merge_group",
			runStartedAt: new Date(NOW).toISOString(),
		});
		await store.queue(trunk, new Date(NOW).toISOString());
		await store.queue(pullRequest, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect((await store.activeLeases()).map((lease) => lease.jobId)).toEqual([
			1,
		]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2, 3]);
		now += 60_001;
		await runtime.tick({ maxDeliveries: 0 });
		expect((await store.activeLeases()).map((lease) => lease.jobId)).toEqual([
			1,
		]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2, 3]);
		const [first] = await store.activeLeases();
		if (!first) throw new Error("running PR lease missing");
		await store.settle(first.id, 0, 1, new Date(now).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([2, 3]);
		expect(await store.pendingJobs()).toEqual([]);
		store.close();
	});

	it("admits trunk heavy alongside a light PR within the full budget", async () => {
		const store = await configuredStore(3);
		const pullRequest = memoryJob(1, "CI fabric contract guard");
		const trunk = memoryJob(2, "PR impact gate", ["hobo-trunk"]);
		const memoryAdmission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "12288" },
				{ totalMemoryMb: 16_384, trunkSlots: 1 },
			),
			{ now: () => NOW },
		);
		const runtime = boxRuntime(
			store,
			memoryGithub([pullRequest, trunk]),
			[],
			undefined,
			{ labels: new Map(), memoryAdmission },
		);
		await store.queue(pullRequest, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		runtime.admissionOrder.prime({
			runId: trunk.runId,
			event: "workflow_dispatch",
			runStartedAt: new Date(NOW).toISOString(),
		});
		await store.queue(trunk, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 2]);
		expect(await store.pendingJobs()).toEqual([]);
		store.close();
	});

	it("caps newly admitted PR jobs while rank-0 trunk is active and removes the cap when it settles", async () => {
		const store = await configuredStore(3);
		const trunk = memoryJob(1, "PR impact gate");
		const firstPr = memoryJob(2, "CI fabric contract guard");
		const secondPr = memoryJob(3, "Secret scan");
		const memoryAdmission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "14336" },
				{ totalMemoryMb: 16_384, trunkSlots: 0 },
			),
			{ now: () => NOW, prCapWithTrunk: 1 },
		);
		const github = memoryGithub([trunk, firstPr, secondPr]);
		github.started.set(trunk.runId, {
			event: "push",
			at: new Date(NOW).toISOString(),
		});
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			memoryAdmission,
		});
		for (const job of [trunk, firstPr, secondPr])
			await store.queue(job, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 2]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([3]);
		const trunkLease = (await store.activeLeases()).find(
			(lease) => lease.jobId === trunk.id,
		);
		if (!trunkLease) throw new Error("trunk lease missing");
		await store.settle(trunkLease.id, 0, 1, new Date(NOW).toISOString());
		await runtime.tick({ maxDeliveries: 0 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([2, 3]);
		expect(await store.pendingJobs()).toEqual([]);
		store.close();
	});

	it("admits a queued run the status-filtered list leaves out", async () => {
		const store = await configuredStore(2);
		// GitHub's ?status=queued answered total_count 0 for run 41622562414 for
		// over 16 minutes while the unfiltered list showed it queued.
		const github = new FakeGithub(
			{ queued: [], in_progress: [], unlisted: [905] },
			{ 905: [{ id: 21, status: "queued", labels: ["hobo"] }] },
		);
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched);
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		expect(await poller.poll()).toMatchObject({
			runs: 1,
			hoboJobs: 1,
			accepted: 1,
			githubErrors: 0,
		});
		expect(github.calls).toContain(
			"GET /repos/Org/Repo/actions/runs?per_page=50",
		);
		await runtime.tick({ maxDeliveries: 10 });
		const [lease] = await store.activeLeases();
		expect(lease).toMatchObject({ jobId: 21, state: "reserved" });
		expect(launched).toEqual([lease?.id]);
		store.close();
	});

	it("gives the one free slot to the queued job that took longest last time", async () => {
		const store = await configuredStore(1);
		const finished = (id: number, name: string, seconds: number) => ({
			id,
			name,
			status: "completed",
			conclusion: "success",
			labels: ["hobo"],
			runner_name: null,
			started_at: "2026-11-02T11:00:00Z",
			completed_at: new Date(
				Date.parse("2026-11-02T11:00:00Z") + seconds * 1000,
			).toISOString(),
		});
		const github = new FakeGithub(
			{ queued: [900], in_progress: [], completed: [899] },
			{
				899: [
					finished(1, "Secret scan", 14),
					finished(2, "Main full gate", 85),
					finished(3, "CI fabric contract guard", 32),
				],
				900: [
					{ id: 11, name: "Secret scan", status: "queued", labels: ["hobo"] },
					{
						id: 12,
						name: "Main full gate",
						status: "queued",
						labels: ["hobo"],
					},
					{
						id: 13,
						name: "CI fabric contract guard",
						status: "queued",
						labels: ["hobo"],
					},
				],
			},
		);
		const durations = createJobDurations();
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched, durations);
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			durations,
			now: () => NOW,
		});
		expect((await poller.poll()).accepted).toBe(3);
		await runtime.tick({ maxDeliveries: 10 });
		const leases = await store.activeLeases();
		// Ascending job id would have reserved job 11, the 14 s secret scan.
		expect(leases).toHaveLength(1);
		expect(leases[0]).toMatchObject({ jobId: 12, state: "reserved" });
		expect(launched).toEqual([leases[0]?.id]);
		store.close();
	});

	/**
	 * Two PR jobs queue, then a workflow_dispatch run's job asks for the trunk
	 * label while a third PR job queues; then PR job 1 finishes.
	 */
	async function trunkAfterPullRequests(
		generalLeaseLimit?: number,
		lendTrunkSlots?: boolean,
	) {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const launched: string[] = [];
		const labels = new Map<string, string | undefined>();
		const trunk = { labels, generalLeaseLimit, lendTrunkSlots };
		const runtime = boxRuntime(store, github, launched, undefined, trunk);
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		const activeJobs = async () =>
			(await store.activeLeases()).map((lease) => lease.jobId).sort();
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const alone = await activeJobs();
		github.runs.queued.push(900);
		github.jobs[900] = [{ id: 3, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(900, {
			event: "workflow_dispatch",
			at: "2026-11-02T11:59:00Z",
		});
		github.jobs[800]?.push({ id: 4, status: "queued", labels: ["hobo"] });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const busy = await activeJobs();
		const first = (await store.activeLeases()).find(
			(lease) => lease.jobId === 1,
		);
		if (!first) throw new Error("PR job 1 holds no lease");
		await store.transition(
			first.id,
			[first.state],
			(lease) => {
				lease.state = "completed";
			},
			"ci.LeaseCompleted",
			new Date(NOW).toISOString(),
		);
		await runtime.tick({ maxDeliveries: 10 });
		const leases = await store.activeLeases();
		store.close();
		return {
			alone,
			busy,
			freed: leases.map((lease) => lease.jobId).sort(),
			labelOf: (jobId: number) =>
				labels.get(leases.find((lease) => lease.jobId === jobId)?.id ?? ""),
		};
	}

	it("lends the trunk slot to pull requests until a trunk job waits, then gives trunk the next free slot", async () => {
		const box = await trunkAfterPullRequests(1, true);
		// With no trunk job queued the reserved slot is borrowed: PR jobs used to
		// run one at a time on the single general slot.
		expect(box.alone).toEqual([1, 2]);
		// A running job is never preempted; trunk and PR job 4 both wait.
		expect(box.busy).toEqual([1, 2]);
		// Main dispatch 41672800885 waited from 10:22 while PR jobs took every
		// slot that came free; now the first free slot is trunk's.
		expect(box.freed).toEqual([2, 3]);
		expect(box.labelOf(3)).toBe("hobo-trunk");
		expect(box.labelOf(2)).toBe("hobo");
	});

	it.each([
		false,
		true,
	])("admits a queued trunk job before any pull request when a slot frees", async (lendTrunkSlots) => {
		const box = await trunkAfterPullRequests(2, lendTrunkSlots);
		expect(box.alone).toEqual([1, 2]);
		expect(box.busy).toEqual([1, 2]);
		expect(box.freed).toEqual([2, 3]);
		expect(box.labelOf(3)).toBe("hobo-trunk");
	});

	async function expectFreshRunnerAfterSwap(label: "hobo" | "hobo-trunk") {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 3, status: "queued", labels: [label] }] },
		);
		github.started.set(900, {
			event: "merge_group",
			at: "2026-11-02T11:59:00Z",
		});
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const launched: string[] = [];
		const labels = new Map<string, string | undefined>();
		const runtime = boxRuntime(store, github, launched, undefined, { labels });
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const original = (await store.activeLeases()).find(
			(lease) => lease.jobId === 3,
		);
		if (!original) throw new Error("original lease missing");
		expect(labels.get(original.id)).toBe(label);
		await store.transition(
			original.id,
			["reserved"],
			(lease) => {
				lease.state = "running";
			},
			"ci.RunnerRegistered",
			new Date(NOW).toISOString(),
		);

		github.runs.in_progress.push(800);
		github.jobs[800] = [
			{
				id: 1,
				status: "in_progress",
				labels: ["hobo"],
				runner_name: original.runnerName,
			},
		];
		expect(await poller.poll()).toMatchObject({
			waiting: [{ jobId: 3, runId: 900, result: "duplicate" }],
		});
		await runtime.tick({ maxDeliveries: 10 });

		const leases = await store.activeLeases();
		const replacement = leases.find(
			(lease) => lease.jobId === 3 && lease.id !== original.id,
		);
		if (!replacement) throw new Error("replacement lease missing");
		expect(launched).toEqual([original.id, replacement.id]);
		expect(labels.get(replacement.id)).toBe(label);
		expect(await store.get(original.id)).toMatchObject({
			id: original.id,
			state: "running",
			actualJobId: 1,
			runnerName: original.runnerName,
		});
		expect(
			leases.filter(
				(lease) =>
					lease.jobId === 3 &&
					(lease.actualJobId === 0 || lease.actualJobId === 3),
			),
		).toEqual([replacement]);

		await runtime.tick({ maxDeliveries: 10 });
		expect(launched).toEqual([original.id, replacement.id]);
		expect(await store.activeLeases()).toHaveLength(2);
		store.close();
	}

	it("launches a fresh trunk-only runner when the trunk job's runner is taken and the job is still queued", async () => {
		await expectFreshRunnerAfterSwap("hobo-trunk");
	});

	it("launches a fresh hobo runner when the job's runner is taken and the job is still queued", async () => {
		await expectFreshRunnerAfterSwap("hobo");
	});

	it("reserves the trunk job again after its runner takes a pull request", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [800, 900], in_progress: [] },
			{
				800: [{ id: 1, status: "queued", labels: ["hobo"] }],
				900: [{ id: 3, status: "queued", labels: ["hobo"] }],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		github.started.set(900, {
			event: "push",
			at: "2026-11-02T11:59:00Z",
		});
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels: new Map(),
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const initial = await store.activeLeases();
		const first = initial.find((lease) => lease.jobId === 1);
		const swapped = initial.find((lease) => lease.jobId === 3);
		if (!first || !swapped) throw new Error("initial leases missing");
		launched.length = 0;

		github.jobs[800]?.push(
			{
				id: 2,
				status: "in_progress",
				labels: ["hobo"],
				runner_name: swapped.runnerName,
			},
			{ id: 4, status: "queued", labels: ["hobo"] },
		);
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect((await store.get(swapped.id))?.actualJobId).toBe(2);
		expect((await store.pendingJobs()).map((job) => job.id)).toContain(3);
		await store.transition(
			swapped.id,
			[swapped.state],
			(lease) => {
				lease.state = "running";
			},
			"ci.RunnerRegistered",
			new Date(NOW).toISOString(),
		);
		const originalJobReads = () =>
			github.calls.filter(
				(call) => call === "GET /repos/Org/Repo/actions/jobs/3",
			).length;
		const afterRequeue = originalJobReads();
		await runtime.tick({ maxDeliveries: 10 });
		expect(originalJobReads()).toBe(afterRequeue);

		await store.transition(
			first.id,
			[first.state],
			(lease) => {
				lease.state = "completed";
			},
			"ci.LeaseCompleted",
			new Date(NOW).toISOString(),
		);
		await runtime.tick({ maxDeliveries: 10 });
		const trunkLeases = (await store.activeLeases()).filter(
			(lease) => lease.jobId === 3,
		);
		const replacement = trunkLeases.find((lease) => lease.id !== swapped.id);
		expect(replacement).toBeDefined();
		expect(launched).toEqual([replacement?.id]);
		expect(
			(await store.activeLeases()).some((lease) => lease.jobId === 4),
		).toBe(false);
		store.close();
	});

	it("reclaims an unlaunched pull request reservation for a waiting trunk job", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels: new Map(),
			generalLeaseLimit: 1,
			lendTrunkSlots: true,
			skipLaunchFor: [2],
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const general = await store.activeLeases();
		const running = general.find((lease) => lease.jobId === 1);
		const reserved = general.find((lease) => lease.jobId === 2);
		if (!running || !reserved) throw new Error("PR leases missing");
		await store.transition(
			running.id,
			[running.state],
			(lease) => {
				lease.state = "running";
			},
			"ci.RunnerRegistered",
			new Date(NOW).toISOString(),
		);
		launched.length = 0;
		github.runs.queued.push(900);
		github.jobs[900] = [{ id: 3, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(900, {
			event: "push",
			at: "2026-11-02T11:59:00Z",
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });

		expect((await store.get(running.id))?.state).toBe("running");
		expect((await store.get(reserved.id))?.state).toBe("cancelled");
		expect((await store.pendingJobs()).map((job) => job.id)).toContain(2);
		const trunk = (await store.activeLeases()).find(
			(lease) => lease.jobId === 3,
		);
		expect(trunk).toBeDefined();
		expect(launched).toEqual([trunk?.id]);
		store.close();
	});

	it("reclaims the newest unlaunched general reservation for excess trunk demand in strict mode", async () => {
		const store = await configuredStore(3);
		const github = new FakeGithub(
			{ queued: [800, 900], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
				900: [{ id: 3, status: "queued", labels: ["hobo-trunk"] }],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		github.started.set(900, { event: "push", at: "2026-11-02T11:55:00Z" });
		const launched: string[] = [];
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels: new Map(),
			generalLeaseLimit: 2,
			skipLaunchFor: [1, 2],
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const initial = await store.activeLeases();
		const older = initial.find((lease) => lease.jobId === 1);
		const newest = initial.find((lease) => lease.jobId === 2);
		const runningTrunk = initial.find((lease) => lease.jobId === 3);
		if (!older || !newest || !runningTrunk)
			throw new Error("initial leases missing");
		for (const [lease, createdAt] of [
			[older, "2026-11-02T11:56:00Z"],
			[newest, "2026-11-02T11:57:00Z"],
			[runningTrunk, "2026-11-02T11:55:00Z"],
		] as const) {
			await store.transition(
				lease.id,
				[lease.state],
				(entry) => {
					entry.createdAt = createdAt;
					if (lease.jobId === 3) entry.state = "running";
				},
				"ci.RunnerRegistered",
				new Date(NOW).toISOString(),
			);
		}

		github.runs.queued.push(901);
		github.jobs[901] = [{ id: 4, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(901, { event: "push", at: "2026-11-02T11:59:00Z" });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });

		expect((await store.get(older.id))?.state).toBe("reserved");
		expect((await store.get(newest.id))?.state).toBe("cancelled");
		expect((await store.get(runningTrunk.id))?.state).toBe("running");
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2]);
		const excessTrunk = (await store.activeLeases()).find(
			(lease) => lease.jobId === 4,
		);
		expect(excessTrunk).toBeDefined();
		expect(launched).toEqual([runningTrunk.id, excessTrunk?.id]);
		store.close();
	});

	it("never preempts running pull request jobs for excess trunk demand", async () => {
		const store = await configuredStore(3);
		const github = new FakeGithub(
			{ queued: [800, 900], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
				900: [{ id: 3, status: "queued", labels: ["hobo-trunk"] }],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		github.started.set(900, { event: "push", at: "2026-11-02T11:55:00Z" });
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			generalLeaseLimit: 2,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		for (const lease of await store.activeLeases()) {
			await store.transition(
				lease.id,
				[lease.state],
				(entry) => {
					entry.state = "running";
				},
				"ci.RunnerRegistered",
				new Date(NOW).toISOString(),
			);
		}

		github.runs.queued.push(901);
		github.jobs[901] = [{ id: 4, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(901, { event: "push", at: "2026-11-02T11:59:00Z" });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });

		expect(
			(await store.activeLeases())
				.map((lease) => [lease.jobId, lease.state] as const)
				.sort((a, b) => a[0] - b[0]),
		).toEqual([
			[1, "running"],
			[2, "running"],
			[3, "running"],
		]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([4]);
		store.close();
	});

	it("keeps the reserved trunk slot free until a trunk job is queued", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const launched: string[] = [];
		const labels = new Map<string, string | undefined>();
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels,
			generalLeaseLimit: 1,
		});
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const general = await store.activeLeases();
		expect(general.map((lease) => lease.jobId)).toEqual([1]);
		expect(launched).toEqual([general[0]?.id]);
		expect(labels.get(general[0]?.id ?? "")).toBe("hobo");

		github.runs.queued.push(900);
		github.jobs[900] = [{ id: 3, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(900, { event: "push", at: "2026-11-02T11:59:00Z" });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		const leases = await store.activeLeases();
		const trunk = leases.find((lease) => lease.jobId === 3);
		if (!trunk) throw new Error("trunk job holds no lease");
		expect(leases.map((lease) => lease.jobId).sort()).toEqual([1, 3]);
		expect(launched).toEqual([general[0]?.id, trunk.id]);
		expect(labels.get(trunk.id)).toBe("hobo-trunk");
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([2]);
		store.close();
	});

	it("reads each active lease's runner label at most once across dispatch ticks", async () => {
		const store = await configuredStore(3);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			generalLeaseLimit: 2,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		for (const lease of await store.activeLeases()) {
			await store.transition(
				lease.id,
				[lease.state],
				(entry) => {
					entry.state = "running";
				},
				"ci.RunnerRegistered",
				new Date(NOW).toISOString(),
			);
		}

		const restarted = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			generalLeaseLimit: 2,
		});
		const restartedPoller = createGithubJobPoller({
			github,
			admissionOrder: restarted.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => restarted.ingestWebhook(delivery),
			now: () => NOW,
		});
		github.runs.queued.push(901);
		github.jobs[901] = [{ id: 3, status: "queued", labels: ["hobo"] }];
		github.started.set(901, {
			event: "pull_request",
			at: "2026-11-02T11:59:00Z",
		});
		await restartedPoller.poll();
		github.calls.length = 0;
		for (let tick = 0; tick < 4; tick++)
			await restarted.tick({ maxDeliveries: 10 });

		const active = await store.activeLeases();
		expect(active.map((lease) => lease.jobId).sort()).toEqual([1, 2]);
		for (const lease of active) {
			const path = `GET /repos/Org/Repo/actions/jobs/${lease.jobId}`;
			expect(github.calls.filter((call) => call === path)).toHaveLength(1);
		}
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([3]);
		store.close();
	});

	it("spends the reserved trunk slot only on a trunk-labelled runner", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = await configuredStore(3);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const launched: string[] = [];
		const labels = new Map<string, string | undefined>();
		const runtime = boxRuntime(store, github, launched, undefined, {
			labels,
			generalLeaseLimit: 2,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		for (const lease of await store.activeLeases()) {
			await store.transition(
				lease.id,
				[lease.state],
				(entry) => {
					entry.state = "running";
				},
				"ci.RunnerRegistered",
				new Date(NOW).toISOString(),
			);
		}

		github.runs.queued.push(900, 901);
		github.jobs[900] = [{ id: 3, status: "queued", labels: ["hobo"] }];
		github.jobs[901] = [{ id: 4, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(900, { event: "push", at: "2026-11-02T11:58:00Z" });
		github.started.set(901, { event: "push", at: "2026-11-02T11:59:00Z" });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		await runtime.tick({ maxDeliveries: 10 });

		const leases = await store.activeLeases();
		expect(leases.map((lease) => lease.jobId).sort()).toEqual([1, 2, 4]);
		const trunk = leases.find((lease) => lease.jobId === 4);
		expect(labels.get(trunk?.id ?? "")).toBe("hobo-trunk");
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([3]);
		const logs = log.mock.calls;
		log.mockRestore();
		expect(logs).toEqual([
			[
				JSON.stringify({
					event: "hobo_ci_trunk_job_on_shared_label",
					repository: "Org/Repo",
					workflow: ".github/workflows/ci.yml",
					runId: 900,
					jobId: 3,
				}),
			],
		]);
		store.close();
	});

	it("admits a trunk-labelled job ahead of pull requests when its run lookup fails", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{ 800: [{ id: 1, status: "queued", labels: ["hobo"] }] },
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			generalLeaseLimit: 1,
		});
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });

		github.runs.queued.push(900);
		github.jobs[900] = [{ id: 2, status: "queued", labels: ["hobo-trunk"] }];
		github.jobs[800]?.push({ id: 3, status: "queued", labels: ["hobo"] });
		await poller.poll();
		const pendingJobs = store.pendingJobs.bind(store);
		store.pendingJobs = async () => {
			const jobs = await pendingJobs();
			github.failing.add("/repos/Org/Repo/actions/runs/900");
			return jobs;
		};
		await runtime.tick({ maxDeliveries: 10 });

		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 2]);
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([3]);
		store.close();
	});

	it("gives a second trunk job the freed general slot ahead of a queued pull request", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [900, 800], in_progress: [] },
			{
				900: [{ id: 1, status: "queued", labels: ["hobo-trunk"] }],
				800: [
					{ id: 2, status: "queued", labels: ["hobo"] },
					{ id: 3, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(900, { event: "push", at: "2026-11-02T11:55:00Z" });
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const labels = new Map<string, string | undefined>();
		const runtime = boxRuntime(store, github, [], undefined, {
			labels,
			generalLeaseLimit: 1,
		});
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 2]);

		github.runs.queued.push(901);
		github.jobs[901] = [{ id: 4, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(901, { event: "push", at: "2026-11-02T11:59:00Z" });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 2]);
		const general = (await store.activeLeases()).find(
			(lease) => lease.jobId === 2,
		);
		if (!general) throw new Error("general lease missing");
		await store.transition(
			general.id,
			[general.state],
			(lease) => {
				lease.state = "completed";
			},
			"ci.LeaseCompleted",
			new Date(NOW).toISOString(),
		);
		await runtime.tick({ maxDeliveries: 10 });

		const leases = await store.activeLeases();
		expect(leases.map((lease) => lease.jobId).sort()).toEqual([1, 4]);
		const secondTrunk = leases.find((lease) => lease.jobId === 4);
		expect(labels.get(secondTrunk?.id ?? "")).toBe("hobo-trunk");
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([3]);
		store.close();
	});

	it("keeps a lease released mid-pass for the trunk job that just missed one", async () => {
		const store = await configuredStore(2);
		const github = new FakeGithub(
			{ queued: [800], in_progress: [] },
			{
				800: [
					{ id: 1, status: "queued", labels: ["hobo"] },
					{ id: 2, status: "queued", labels: ["hobo"] },
				],
			},
		);
		github.started.set(800, {
			event: "pull_request",
			at: "2026-11-02T11:50:00Z",
		});
		const runtime = boxRuntime(store, github, [], undefined, {
			labels: new Map(),
			generalLeaseLimit: 1,
			lendTrunkSlots: true,
		});
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		github.runs.queued.push(900);
		github.jobs[900] = [{ id: 3, status: "queued", labels: ["hobo-trunk"] }];
		github.started.set(900, { event: "push", at: "2026-11-02T11:59:00Z" });
		github.jobs[800]?.push({ id: 4, status: "queued", labels: ["hobo"] });
		await poller.poll();
		const reserve = store.reserve.bind(store);
		let released = false;
		store.reserve = async (account, job, at, revision) => {
			const lease = await reserve(account, job, at, revision);
			if (job.id === 3 && !lease && !released) {
				released = true;
				const first = (await store.activeLeases()).find(
					(entry) => entry.jobId === 1,
				);
				if (first)
					await store.transition(
						first.id,
						[first.state],
						(entry) => {
							entry.state = "completed";
						},
						"ci.LeaseCompleted",
						at,
					);
			}
			return lease;
		};
		await runtime.tick({ maxDeliveries: 10 });
		const afterRelease = (await store.activeLeases()).map(
			(lease) => lease.jobId,
		);
		await runtime.tick({ maxDeliveries: 10 });
		const next = (await store.activeLeases())
			.map((lease) => lease.jobId)
			.sort();
		store.close();
		expect(released).toBe(true);
		// Without the cap PR job 4, next in the same pass, took the freed lease.
		expect(afterRelease).toEqual([2]);
		expect(next).toEqual([2, 3]);
	});

	it("without a general lease limit, trunk still takes the next free slot first", async () => {
		const box = await trunkAfterPullRequests();
		expect(box.alone).toEqual([1, 2]);
		expect(box.freed).toEqual([2, 3]);
	});

	it("admits queued trunk work on the tick after each runner exits in the 06:16 timeline", async () => {
		const store = await configuredStore(3);
		const fake = new FakeGithub(
			{ queued: [700, 800], in_progress: [] },
			{
				700: [{ id: 1, status: "queued", labels: ["hobo-trunk"] }],
				800: [
					{ id: 2, status: "queued", labels: ["hobo"] },
					{ id: 3, status: "queued", labels: ["hobo"] },
				],
			},
		);
		fake.started.set(700, {
			event: "merge_group",
			at: "2026-11-04T06:16:47Z",
		});
		fake.started.set(800, {
			event: "pull_request",
			at: "2026-11-04T06:16:40Z",
		});
		let runnerId = 0;
		const github: GithubTransport = {
			async request(installationId, path, method = "GET", body, ifNoneMatch) {
				if (
					method === "POST" &&
					path === "/repos/Org/Repo/actions/runners/generate-jitconfig"
				) {
					runnerId += 1;
					return Response.json(
						{ encoded_jit_config: "c2VjcmV0", runner: { id: runnerId } },
						{ status: 201 },
					);
				}
				return fake.request(installationId, path, method, body, ifNoneMatch);
			},
		};
		const containers = new Map<string, { running: boolean; exited: boolean }>();
		let containerId = 0;
		const docker: DockerDriver = {
			create: async (spec) => {
				containerId += 1;
				const id = containerId.toString(16).padStart(64, "0");
				containers.set(id, { running: false, exited: false });
				return { name: spec.name, containerId: id };
			},
			start: async (_name, id) => {
				const container = containers.get(id);
				if (container) container.running = true;
			},
			exec: async () => ({ exitCode: 0 }),
			execDetached: async () => ({ exitCode: 0 }),
			writeSecret: async () => {},
			stop: async (_name, id) => {
				const container = containers.get(id);
				if (container) container.running = false;
			},
			remove: async (_name, id) => {
				containers.delete(id);
			},
			isRunning: async (_name, id) => containers.get(id)?.running ?? false,
			exists: async (_name, id, path) =>
				path === "/tmp/hobo-ci-runner-exited" &&
				(containers.get(id)?.exited ?? false),
		};
		let clock = Date.parse("2026-11-04T06:16:47Z");
		const now = () => new Date(clock).toISOString();
		const worker = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://relay.example",
			docker,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			slots: 3,
			now,
		});
		const runtime = createHostedRelayRuntime({
			store,
			github,
			identity: {
				async verify() {
					throw new Error("pull mode never verifies OIDC");
				},
			},
			webhookSecret: randomUUID() + randomUUID(),
			isolatedHost: worker.host,
			denyUnisolated: true,
			generalLeaseLimit: 2,
			control: async () => undefined,
			now,
		});
		const poller = createGithubJobPoller({
			github,
			admissionOrder: runtime.admissionOrder,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => clock,
		});
		const leaseFor = async (jobId: number) => {
			const lease = (await store.activeLeases()).find(
				(entry) => entry.jobId === jobId,
			);
			if (!lease) throw new Error(`job ${jobId} holds no lease`);
			return lease;
		};
		const finish = async (jobId: number, at: string, exitMarker = true) => {
			const lease = await leaseFor(jobId);
			const container = containers.get(lease.sandboxSessionId);
			if (container && exitMarker) container.exited = true;
			for (const jobs of Object.values(fake.jobs)) {
				const job = jobs.find((entry) => entry.id === jobId);
				if (job) {
					job.status = "completed";
					job.conclusion = "success";
					job.runner_name = lease.runnerName;
				}
			}
			clock = Date.parse(at);
			await runtime.tick({ maxDeliveries: 10 });
		};

		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([1, 2, 3]);

		await finish(1, "2026-11-04T06:17:50Z", false);
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([2, 3]);

		clock = Date.parse("2026-11-04T06:18:26Z");
		fake.runs.queued.push(900, 901);
		fake.jobs[900] = [{ id: 4, status: "queued", labels: ["hobo-trunk"] }];
		fake.jobs[901] = [{ id: 5, status: "queued", labels: ["hobo-trunk"] }];
		fake.started.set(900, { event: "push", at: "2026-11-04T06:18:26Z" });
		fake.started.set(901, { event: "push", at: "2026-11-04T06:18:26Z" });
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([2, 3, 4]);
		expect((await store.get((await leaseFor(4)).id))?.state).toBe("running");
		expect((await store.pendingJobs()).map((job) => job.id)).toEqual([5]);

		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		clock = Date.parse("2026-11-04T06:18:37Z");
		await runtime.tick({ maxDeliveries: 10 });
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({
				event: "hobo_ci_trunk_wait",
				reason: "lease-capacity",
				waitedMs: 11_000,
				repository: REPO,
				runId: 901,
				jobId: 5,
			}),
		);
		log.mockRestore();

		await finish(2, "2026-11-04T06:21:34Z");
		expect(
			(await store.activeLeases()).map((lease) => lease.jobId).sort(),
		).toEqual([3, 4, 5]);
		expect((await store.get((await leaseFor(5)).id))?.state).toBe("running");
		store.close();
	});

	it("launches a trunk runner in a pre-warmed container under the trunk label", async () => {
		const store = await configuredStore(2);
		const fake = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 3, status: "queued", labels: ["hobo-trunk"] }] },
		);
		fake.started.set(900, { event: "push", at: "2026-11-02T11:59:00Z" });
		const registrations: unknown[] = [];
		const github: GithubTransport = {
			async request(installationId, path, method = "GET", body, ifNoneMatch) {
				if (
					method === "POST" &&
					path === "/repos/Org/Repo/actions/runners/generate-jitconfig"
				) {
					registrations.push(JSON.parse(body ?? "null"));
					return Response.json(
						{ encoded_jit_config: "c2VjcmV0", runner: { id: 42 } },
						{ status: 201 },
					);
				}
				return fake.request(installationId, path, method, body, ifNoneMatch);
			},
		};
		const dockerCalls: string[] = [];
		const docker: DockerDriver = {
			create: async (spec) => {
				dockerCalls.push(`create ${spec.name}`);
				return { name: spec.name, containerId: "c".repeat(64) };
			},
			start: async () => {},
			exec: async () => ({ exitCode: 0 }),
			writeSecret: async () => {},
			rename: async (_id, name) => {
				dockerCalls.push(`rename ${name}`);
			},
			updateResources: async (containerId, weights) => {
				dockerCalls.push(
					`update ${containerId} ${weights.cpuShares} ${weights.blkioWeight ?? "off"}`,
				);
			},
			stop: async () => {},
			remove: async () => {},
			isRunning: async () => true,
		};
		const now = () => new Date(NOW).toISOString();
		const worker = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://relay.example",
			docker,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			slots: 2,
			now,
		});
		await worker.prewarm();
		const runtime = createHostedRelayRuntime({
			store,
			github,
			identity: {
				async verify() {
					throw new Error("pull mode never verifies OIDC");
				},
			},
			webhookSecret: randomUUID() + randomUUID(),
			isolatedHost: worker.host,
			denyUnisolated: true,
			control: async () => undefined,
			now,
		});
		const poller = createGithubJobPoller({
			github,
			connections: async () =>
				(await store.configuration())?.configuration?.connections ?? [],
			ingest: (delivery) => runtime.ingestWebhook(delivery),
			now: () => NOW,
		});
		await poller.poll();
		await runtime.tick({ maxDeliveries: 10 });
		expect(registrations).toEqual([
			expect.objectContaining({ labels: ["hobo-trunk"] }),
		]);
		const [lease] = await store.activeLeases();
		expect(lease).toMatchObject({ jobId: 3, state: "running" });
		expect(dockerCalls[0]).toMatch(/^create hobo-warm-/);
		expect(dockerCalls).toContain(`update ${"c".repeat(64)} 8192 800`);
		expect(dockerCalls).toContain(`rename hobo-${lease?.id}`);
		store.close();
	});

	it("creates the job container with its admitted memory request and environment", async () => {
		const store = await configuredStore(1);
		const state = await store.configuration();
		const account = state?.configuration.accounts[0];
		if (!account) throw new Error("worker account missing");
		const lease = await store.reserve(
			account,
			create(JobSchema, {
				id: 77,
				runId: 977,
				runAttempt: 1,
				repositoryId: CONNECTION.repositoryId,
				installationId: CONNECTION.installationId,
				repository: REPO,
				labels: ["hobo"],
				name: "CI fabric contract guard",
				memoryClass: "light",
				memoryMb: 3_072,
				action: "queued",
				isolatedRequired: true,
			}),
			new Date(NOW).toISOString(),
		);
		if (!lease) throw new Error("reserved lease missing");
		const github: GithubTransport = {
			async request(_installationId, path, method = "GET") {
				if (
					method === "POST" &&
					path === "/repos/Org/Repo/actions/runners/generate-jitconfig"
				)
					return Response.json(
						{ encoded_jit_config: "c2VjcmV0", runner: { id: 42 } },
						{ status: 201 },
					);
				throw new Error(`unexpected ${method} ${path}`);
			},
		};
		const specs: Parameters<DockerDriver["create"]>[0][] = [];
		const docker: DockerDriver = {
			create: async (spec) => {
				specs.push(spec);
				return { name: spec.name, containerId: "c".repeat(64) };
			},
			start: async () => {},
			exec: async () => ({ exitCode: 0 }),
			writeSecret: async () => {},
			stop: async () => {},
			remove: async () => {},
			isRunning: async () => true,
		};
		const worker = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://relay.example",
			docker,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			now: () => new Date(NOW).toISOString(),
		});
		await worker.host.launch(lease.id, "hobo");
		expect(specs).toEqual([
			expect.objectContaining({
				memoryMb: 3_072,
				env: expect.objectContaining({ HOBO_CI_JOB_MEMORY_MB: "3072" }),
			}),
		]);
		store.close();
	});
});
