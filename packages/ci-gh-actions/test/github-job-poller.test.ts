import { randomUUID } from "node:crypto";
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
}

/** Answers only the REST reads the poller and relay make; anything else is a contract violation. */
class FakeGithub implements GithubTransport {
	calls: string[] = [];
	limited = false;
	constructor(
		readonly runs: Record<"queued" | "in_progress", number[]>,
		readonly jobs: Record<number, FakeJob[]>,
	) {}
	async request(installationId: number, path: string, method = "GET") {
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
				{ workflow_runs: this.runs[list[1]].map((id) => ({ id })) },
				{ headers },
			);
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
						run_attempt: 1,
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
		if (job1) job1.runner_name = "hobo-a742da4d";
		expect(await poller.poll()).toMatchObject({ accepted: 1, failed: 1 });
		expect(errors).toEqual([2, 2]);
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

	it("admits a polled queued job into a reserved box lease and launches it, with no relay or webhook", async () => {
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
								concurrency: 2,
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
		const github = new FakeGithub(
			{ queued: [900], in_progress: [] },
			{ 900: [{ id: 1, status: "queued", labels: ["hobo"] }] },
		);
		const launched: string[] = [];
		const runtime = createHostedRelayRuntime({
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
		});
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
});
