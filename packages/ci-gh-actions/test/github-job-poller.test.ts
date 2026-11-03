import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { GithubTransport } from "../src/github.js";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { createGithubJobPoller } from "../src/isolated-worker/github-job-poller.js";
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
	/** Run attempt per run id; 1 when absent. */
	attempts = new Map<number, number>();
	constructor(
		readonly runs: Record<"queued" | "in_progress", number[]> & {
			completed?: number[];
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
				event: "pull_request",
				head_sha: "a".repeat(40),
				head_branch: "feature",
				path: ".github/workflows/ci.yml",
				display_title: "CI",
				status: "queued",
				conclusion: null,
				run_started_at: null,
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
		expect(github.counted).toHaveLength(4);
		github.counted = [];
		clock += 15_000;
		// A 304 still hands the cached body on, so the job is observed again.
		expect(await poller.poll()).toMatchObject({
			hoboJobs: 1,
			accepted: 0,
			notModified: 4,
		});
		expect(github.counted).toEqual([]);
		expect(ids).toEqual(["poll-1-1-q", "poll-1-1-q"]);
		// A changed list is a 200 again, and only that read is counted.
		github.jobs[900]?.push({ id: 2, status: "queued", labels: ["hobo"] });
		expect(await poller.poll()).toMatchObject({ accepted: 1, notModified: 3 });
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
});

describe("pull-mode box worker over SQLite", () => {
	let root = "";
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "hobo-ci-pull-"));
	});
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function configuredStore(concurrency: number) {
		const store = new SqliteCiStore(join(root, `${randomUUID()}.sqlite`));
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
				async launch(id) {
					launched.push(id);
				},
				async reconcile() {},
			},
			denyUnisolated: true,
			control: async () => undefined,
			now: () => new Date(NOW).toISOString(),
		};
		if (jobDurations) options.jobDurations = jobDurations;
		return createHostedRelayRuntime(options);
	}

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
});
