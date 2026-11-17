/**
 * Automatic retry (ADR-0183, case R10) and the re-decision it causes (R12):
 * the rules against in-memory ports, the ledger on SQLite, and the whole
 * loop against the GitHub simulator, including a redelivered webhook.
 */
import { DatabaseSync } from "node:sqlite";
import { create } from "@bufbuild/protobuf";
import {
	answerRelayJob,
	type MachineEvent,
	type RelayJobAnswer,
	RunnerRouteEventSchema,
	type RunnerRouteRequest,
	RunnerRouteRequestSchema,
} from "@hobo/ci";
import type { InsightJob, InsightRun } from "@hobo/ci/insights";
import { SqliteInsightStore } from "@hobo/ci/insights/history-sqlite";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	type AutoRetryDeps,
	autoRetryRun,
	githubCheckRunAnnotations,
	githubRerunJob,
	InMemoryRetryLedger,
	isRelayJobOf,
	machineEventDisconnects,
	type RerunJob,
	RetryRouteFacts,
	retryLedgerConformance,
	routeRetryFor,
	SqliteRetryLedger,
	testJobRetried,
} from "../src/auto-retry.js";
import { InsightIngest } from "../src/insight-ingest.js";
import {
	GithubSimulator,
	simulatorTransport,
} from "./support/github-simulator/index.js";

const REPO = "octo/app";
const ACCOUNT = "acct-1";
const T0 = Date.UTC(2026, 10, 16, 12);
const MINUTE = 60_000;
const ORDER_RETRY_OTHER =
	'{"steps":[{"key":"github"},{"key":"blacksmith"}],"retry":{"enabled":true,"runner":"other","max":2}}';

// --- In-memory rules ------------------------------------------------------

function job(
	init: Partial<InsightJob> & Pick<InsightJob, "id" | "name">,
): InsightJob {
	return {
		labels: ["ubuntu-24.04"],
		conclusion: "failure",
		queuedAtMs: T0,
		startedAtMs: T0 + MINUTE,
		completedAtMs: T0 + 2 * MINUTE,
		steps: [{ name: "Set up job", number: 1, conclusion: "failure" }],
		billed: true,
		...init,
	};
}

function run(init: Partial<InsightRun> = {}): InsightRun {
	return {
		id: 9001,
		attempt: 1,
		repository: REPO,
		workflow: "ci",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "abc",
		actor: "octocat",
		conclusion: "failure",
		createdAtMs: T0,
		completedAtMs: T0 + 3 * MINUTE,
		jobs: [
			job({
				id: 1,
				name: "route",
				labels: ["hobo-relay"],
				conclusion: "success",
				relay: true,
				steps: [],
			}),
			job({ id: 2, name: "build" }),
		],
		...init,
	};
}

function decided(
	init: Readonly<{
		jobId?: string;
		runner?: string;
		step?: string;
		machineId?: string;
		attempt?: number;
	}> = {},
) {
	return create(RunnerRouteEventSchema, {
		type: "runner.route.Decided",
		accountId: ACCOUNT,
		atMs: T0 + 30_000,
		request: create(RunnerRouteRequestSchema, {
			repository: REPO,
			private: true,
			event: "push",
			runId: 9001,
			runAttempt: init.attempt ?? 1,
			job: "route",
			inputs: [{ key: "github", labels: ["ubuntu-24.04"] }],
		}),
		decision: {
			outcome: "routed",
			runner: init.runner ?? "ubuntu-24.04",
			step: init.step ?? "github",
			machineId: init.machineId ?? "",
		},
		mode: "relay",
		node: "node-1",
		jobId: init.jobId ?? "relay-1",
	});
}

function setup(
	options: Readonly<{
		order?: string;
		annotations?: readonly string[];
		events?: readonly MachineEvent[];
		rerunStatus?: number;
	}> = {},
) {
	const journal = new InMemoryRouteJournal();
	const ledger = new InMemoryRetryLedger();
	const reruns: { repository: string; jobId: number; rows: number }[] = [];
	const rerun: RerunJob = async (repository, jobId) => {
		// The row is already written when GitHub is asked.
		reruns.push({ repository, jobId, rows: ledger.rows.length });
		const status = options.rerunStatus ?? 201;
		return { ok: status === 201, status };
	};
	const deps: AutoRetryDeps = {
		accountId: ACCOUNT,
		nowMs: T0 + 4 * MINUTE,
		journal,
		ledger,
		order: new InMemoryRunnerOrderSource(
			new Map([[REPO, options.order ?? ORDER_RETRY_OTHER]]),
		),
		annotations: async () => options.annotations ?? [],
		machineDisconnects: machineEventDisconnects(
			async () => options.events ?? [],
		),
		rerun,
	};
	return { deps, journal, ledger, reruns };
}

describe("autoRetryRun", () => {
	it("re-runs the relay job of a job that failed before its own steps, writing the row first", async () => {
		const { deps, journal, ledger, reruns } = setup();
		await journal.record(decided());
		const outcome = await autoRetryRun(run(), deps);
		expect(outcome).toMatchObject({
			retried: true,
			status: 201,
			row: {
				type: "job.retried",
				attempt: 1,
				relayJobId: 1,
				relayJob: "route",
				jobId: 2,
				kind: "runner_start",
				target: "other",
				failedStep: "github",
			},
		});
		expect(reruns).toEqual([{ repository: REPO, jobId: 1, rows: 1 }]);
		expect(ledger.rows).toHaveLength(1);
	});

	it("retries once for a webhook delivered twice", async () => {
		const { deps, journal, reruns } = setup();
		await journal.record(decided());
		const [first, second] = await Promise.all([
			autoRetryRun(run(), deps),
			autoRetryRun(run(), deps),
		]);
		const third = await autoRetryRun(run(), deps);
		expect([first, second].filter((outcome) => outcome.retried)).toHaveLength(
			1,
		);
		expect(third).toEqual({ retried: false, reason: "already_retried" });
		expect(reruns).toHaveLength(1);
	});

	it("retries at most the policy's maximum per run, and never more than twice", async () => {
		const { deps, journal, reruns } = setup();
		for (const attempt of [1, 2, 3])
			await journal.record(decided({ attempt, jobId: `relay-${attempt}` }));
		const outcomes = [];
		for (const attempt of [1, 2, 3])
			outcomes.push(await autoRetryRun(run({ attempt }), deps));
		expect(outcomes.map((outcome) => outcome.retried)).toEqual([
			true,
			true,
			false,
		]);
		expect(outcomes[2]).toEqual({ retried: false, reason: "run_limit" });
		expect(reruns).toHaveLength(2);
	});

	it("leaves a job that failed in its own steps alone", async () => {
		const { deps, journal, reruns } = setup();
		await journal.record(decided());
		const ownFailure = run({
			jobs: [
				run().jobs[0] ?? job({ id: 1, name: "route" }),
				job({
					id: 2,
					name: "build",
					steps: [
						{ name: "Set up job", number: 1, conclusion: "success" },
						{ name: "Test", number: 2, conclusion: "failure" },
					],
				}),
			],
		});
		expect(await autoRetryRun(ownFailure, deps)).toEqual({
			retried: false,
			reason: "own_failure",
		});
		expect(reruns).toHaveLength(0);
	});

	it("does not retry when one of the routed jobs failed on its own", async () => {
		const { deps, journal } = setup();
		await journal.record(decided());
		const ranTests = job({
			id: 3,
			name: "test",
			steps: [{ name: "Test", number: 2, conclusion: "failure" }],
		});
		const mixed = run({ jobs: [...run().jobs, ranTests] });
		expect(await autoRetryRun(mixed, deps)).toEqual({
			retried: false,
			reason: "own_failure",
		});
	});

	const ranTests: InsightJob["steps"] = [
		{ name: "Set up job", number: 1, conclusion: "success" },
		{ name: "Test", number: 2, conclusion: "failure" },
	];

	it("retries a job whose machine disconnected while it ran", async () => {
		const { deps, journal } = setup({
			events: [
				{
					type: "machine.disconnected",
					accountId: ACCOUNT,
					machineId: "m-1",
					atMs: T0 + 90_000,
					by: "octocat",
					signerKeyId: "key-1",
					detail: "studio went offline.",
				},
			],
		});
		await journal.record(
			decided({
				runner: "hobo-machine-m-1",
				step: "machine",
				machineId: "m-1",
			}),
		);
		const lost = run({
			jobs: [
				run().jobs[0] ?? job({ id: 1, name: "route" }),
				job({
					id: 2,
					name: "build",
					labels: ["hobo-machine-m-1"],
					steps: ranTests,
				}),
			],
		});
		expect(await autoRetryRun(lost, deps)).toMatchObject({
			retried: true,
			row: {
				kind: "machine_lost",
				failedStep: "machine",
				failedMachineId: "m-1",
			},
		});
	});

	it("retries a job GitHub says lost its runner", async () => {
		const { deps, journal } = setup({
			annotations: [
				"The self-hosted runner: box-1 lost communication with the server.",
			],
		});
		await journal.record(decided());
		const lost = run({
			jobs: [
				run().jobs[0] ?? job({ id: 1, name: "route" }),
				job({ id: 2, name: "build", steps: ranTests }),
			],
		});
		expect(await autoRetryRun(lost, deps)).toMatchObject({
			retried: true,
			row: { kind: "runner_lost" },
		});
	});

	it("skips what it cannot or may not retry", async () => {
		const off = setup({ order: '{"steps":[{"key":"github"}]}' });
		await off.journal.record(decided());
		expect(await autoRetryRun(run(), off.deps)).toEqual({
			retried: false,
			reason: "off",
		});

		const plain = setup();
		expect(await autoRetryRun(run(), plain.deps)).toEqual({
			retried: false,
			reason: "no_relay_decision",
		});
		await plain.journal.record(decided());
		expect(
			await autoRetryRun(run({ conclusion: "success" }), plain.deps),
		).toEqual({ retried: false, reason: "not_failed" });
		expect(
			await autoRetryRun(
				run({ jobs: [job({ id: 2, name: "build" })] }),
				plain.deps,
			),
		).toEqual({ retried: false, reason: "no_relay_job" });
		expect(
			await autoRetryRun(
				run({
					jobs: [
						run().jobs[0] ?? job({ id: 1, name: "route" }),
						job({ id: 2, name: "build", labels: ["depot-ubuntu-24.04"] }),
					],
				}),
				plain.deps,
			),
		).toEqual({ retried: false, reason: "no_routed_failure" });

		const two = setup();
		await two.journal.record(decided({ jobId: "relay-1" }));
		await two.journal.record(decided({ jobId: "relay-2" }));
		expect(await autoRetryRun(run(), two.deps)).toEqual({
			retried: false,
			reason: "several_relays",
		});

		const broken = setup({ order: '{"steps":[]}' });
		await broken.journal.record(decided());
		expect(await autoRetryRun(run(), broken.deps)).toEqual({
			retried: false,
			reason: "broken_order",
		});
	});

	it("stops at the account's daily cap", async () => {
		const { deps, journal, ledger } = setup();
		await journal.record(decided());
		for (let index = 0; index < 100; index += 1)
			await ledger.claim(
				testJobRetried({ runId: 1 + index, atMs: T0 - MINUTE }),
			);
		expect(await autoRetryRun(run(), deps)).toEqual({
			retried: false,
			reason: "daily_limit",
		});
	});

	it("keeps the row when GitHub refuses the re-run, so a redelivery does not try again", async () => {
		const { deps, journal, ledger } = setup({ rerunStatus: 403 });
		await journal.record(decided());
		expect(await autoRetryRun(run(), deps)).toMatchObject({
			retried: false,
			reason: "rerun_refused",
			status: 403,
		});
		expect(ledger.rows).toHaveLength(1);
		expect(await autoRetryRun(run(), deps)).toEqual({
			retried: false,
			reason: "already_retried",
		});
	});
});

describe("the retry in the next decision", () => {
	function request(attempt: number, relayJob = "route"): RunnerRouteRequest {
		return create(RunnerRouteRequestSchema, {
			repository: "Octo/App",
			runId: 9001,
			runAttempt: attempt,
			job: relayJob,
		});
	}

	it("gives the attempt after a retried one its failed step, machine and target", async () => {
		const ledger = new InMemoryRetryLedger();
		await ledger.claim(
			testJobRetried({
				target: "same",
				failedStep: "machine",
				failedMachineId: "m-1",
			}),
		);
		expect(await routeRetryFor(ledger, request(2))).toEqual({
			target: "same",
			failedStep: "machine",
			failedMachineId: "m-1",
		});
		expect(await routeRetryFor(ledger, request(1))).toBeUndefined();
		expect(await routeRetryFor(ledger, request(3))).toBeUndefined();
		expect(
			await routeRetryFor(ledger, request(2, "other-relay")),
		).toBeUndefined();
	});

	it("adds the retry to the facts the relay walks with", async () => {
		const ledger = new InMemoryRetryLedger();
		await ledger.claim(testJobRetried({ target: "other" }));
		const facts = new RetryRouteFacts(new InMemoryRouteFactsSource(), ledger);
		expect((await facts.facts(request(2), T0)).retry).toEqual({
			target: "other",
			failedStep: "github",
			failedMachineId: undefined,
		});
		expect((await facts.facts(request(1), T0)).retry).toBeUndefined();
	});
});

describe("retry ledger", () => {
	it("keeps its rules in memory", () =>
		retryLedgerConformance(() => new InMemoryRetryLedger()));

	it("keeps its rules on SQLite", () =>
		retryLedgerConformance(
			() => new SqliteRetryLedger(new DatabaseSync(":memory:")),
		));

	it("writes one row when two claims race through one handle", async () => {
		const ledger = new SqliteRetryLedger(new DatabaseSync(":memory:"));
		const claims = await Promise.all([
			ledger.claim(testJobRetried()),
			ledger.claim(testJobRetried({ atMs: 2_000 })),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(await ledger.forRun(REPO, 9001)).toHaveLength(1);
	});

	it("refuses a row that breaks its shape", async () => {
		await expect(
			new InMemoryRetryLedger().claim({ ...testJobRetried(), runId: 0 }),
		).rejects.toThrow();
	});
});

describe("GitHub reads and writes", () => {
	it("recognises a relay job as insight ingest does", () => {
		expect(isRelayJobOf("build", ["hobo-relay"])).toBe(true);
		expect(isRelayJobOf("route", ["ubuntu-latest"])).toBe(true);
		expect(isRelayJobOf("router-tests", ["ubuntu-latest"])).toBe(false);
	});

	it("reads no annotations from a failed read, and status 0 from a network failure", async () => {
		const broken = {
			request: async () => {
				throw new Error("offline");
			},
		};
		const refused = {
			request: async () => new Response("{}", { status: 403 }),
		};
		expect(await githubCheckRunAnnotations(broken, 1)(REPO, 2)).toEqual([]);
		expect(await githubCheckRunAnnotations(refused, 1)(REPO, 2)).toEqual([]);
		expect(await githubRerunJob(broken, 1)(REPO, 2)).toEqual({
			ok: false,
			status: 0,
		});
	});
});

// --- The whole loop against the GitHub simulator (T2) --------------------

/**
 * The simulator serves GitHub's run-level re-runs but not "re-run a job". In
 * these runs every job needs the relay, so re-running the relay and its
 * dependents is re-running the whole run, and this adapter says so; any other
 * shape is refused rather than faked.
 */
function withJobRerun(sim: GithubSimulator): GithubSimulator["fetch"] {
	const base = sim.fetch;
	const adapted = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const match =
			/^\/repos\/([^/]+\/[^/]+)\/actions\/jobs\/(\d+)\/rerun$/u.exec(
				url.pathname,
			);
		if (!match || (init?.method ?? "GET") !== "POST") return base(input, init);
		const relay = sim.state.jobs.get(Number(match[2]));
		if (!relay) return Response.json({ message: "Not Found" }, { status: 404 });
		const others = [...sim.state.jobs.values()].filter(
			(other) =>
				other.runId === relay.runId &&
				other.runAttempt === relay.runAttempt &&
				other.id !== relay.id,
		);
		if (!others.every((other) => other.needs.includes(relay.name)))
			return Response.json({ message: "not modelled" }, { status: 501 });
		return base(
			`${sim.baseUrl}/repos/${match[1]}/actions/runs/${relay.runId}/rerun`,
			{
				method: "POST",
			},
		);
	};
	// SAFETY: the adapter takes fetch's arguments and returns its result.
	return adapted as typeof fetch;
}

function outputsOf(answer: RelayJobAnswer): ReadonlyMap<string, string> {
	return new Map(answer.outputs.map((value) => [value.name, value.value]));
}

function relayLoop() {
	const sim = new GithubSimulator();
	const fetchWithJobRerun = withJobRerun(sim);
	const github = {
		request: simulatorTransport(sim).request,
	};
	const transport = {
		request: (
			installationId: number,
			path: string,
			method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
			body?: string,
		) =>
			path.includes("/actions/jobs/") && method === "POST"
				? fetchWithJobRerun(`${sim.baseUrl}${path}`, { method })
				: github.request(installationId, path, method, body),
	};
	const db = new DatabaseSync(":memory:");
	const store = new SqliteInsightStore(db);
	const ingest = new InsightIngest(store);
	const journal = new InMemoryRouteJournal();
	const ledger = new SqliteRetryLedger(db);
	const order = new InMemoryRunnerOrderSource(
		new Map([[REPO, ORDER_RETRY_OTHER]]),
	);
	const facts = new RetryRouteFacts(new InMemoryRouteFactsSource(), ledger);
	const outcomes: Awaited<ReturnType<typeof autoRetryRun>>[] = [];
	const decisions: string[] = [];
	sim.registerRunner({ name: "relay-node", labels: ["hobo-relay"] });
	sim.registerRunner({ name: "gh-1", labels: ["ubuntu-24.04"] });
	sim.registerRunner({
		name: "bs-1",
		labels: ["blacksmith-2vcpu-ubuntu-2404"],
	});

	/** The relay's webhook endpoint: fold history in, retry a failed run. */
	const handler = async (request: Request): Promise<Response> => {
		const event = request.headers.get("x-github-event") ?? "";
		const body = await request.text();
		const stored = await ingest.deliver(event, body);
		const action = JSON.parse(body).action;
		if (event === "workflow_run" && action === "completed" && stored)
			outcomes.push(
				await autoRetryRun(stored, {
					accountId: ACCOUNT,
					nowMs: sim.nowMs(),
					journal,
					ledger,
					order,
					annotations: githubCheckRunAnnotations(transport, 1),
					machineDisconnects: async () => [],
					rerun: githubRerunJob(transport, 1),
				}),
			);
		return new Response(null, { status: 202 });
	};

	/** The relay claims its job and answers it, as relay mode does. */
	const answerRelay = async (): Promise<string> => {
		const claimed = sim.claim("relay-node");
		if (!claimed) throw new Error("no relay job to claim");
		const answer = await answerRelayJob(sim.relayJobMessage(claimed.id), {
			order,
			facts,
			journal,
			nowMs: sim.nowMs(),
			mode: "relay",
			node: "relay-1",
			accountId: ACCOUNT,
			checks: undefined,
		});
		const runner = outputsOf(answer).get("runner") ?? "";
		decisions.push(runner);
		sim.complete(claimed.id, {
			conclusion: answer.conclusion === "succeeded" ? "success" : "failure",
			outputs: outputsOf(answer),
		});
		return runner;
	};

	const queueRun = () => {
		const relay = sim.queueJob({
			repository: REPO,
			name: "route",
			labels: ["hobo-relay"],
			inputs: new Map([
				["github", "ubuntu-24.04"],
				["blacksmith", "blacksmith-2vcpu-ubuntu-2404"],
			]),
		});
		sim.queueJob({
			repository: REPO,
			name: "build",
			runId: relay.runId,
			labels: ["${{ needs.route.outputs.runner }}"],
			needs: ["route"],
		});
		return relay.runId;
	};

	return { sim, handler, answerRelay, queueRun, outcomes, decisions, ledger };
}

describe("automatic retry against the GitHub simulator", () => {
	it("R10: a job that failed before its steps is retried once for a webhook delivered twice, and the relay decides again", async () => {
		const loop = relayLoop();
		const { sim } = loop;
		const runId = loop.queueRun();
		expect(await loop.answerRelay()).toBe("ubuntu-24.04");
		const build = sim.claim("gh-1");
		expect(build?.name).toBe("build");
		sim.advance(MINUTE);
		sim.complete(build?.id ?? 0, {
			conclusion: "failure",
			steps: [{ name: "Set up job", conclusion: "failure" }],
		});
		await sim.deliver(loop.handler);
		expect(loop.outcomes).toMatchObject([
			{ retried: true, row: { kind: "runner_start", target: "other" } },
		]);

		// GitHub redelivers the completed webhook: nothing is retried again.
		const completed = sim
			.deliveries()
			.filter((delivery) => delivery.event === "workflow_run");
		expect(completed).toHaveLength(1);
		sim.redeliver(completed[0]?.id ?? "");
		await sim.deliver(loop.handler);
		expect(loop.outcomes.map((outcome) => outcome.retried)).toEqual([
			true,
			false,
		]);
		expect(loop.outcomes[1]).toEqual({
			retried: false,
			reason: "already_retried",
		});
		const reruns = sim
			.requests()
			.filter(
				(request) => request.method === "POST" && /rerun/u.test(request.path),
			);
		expect(reruns).toHaveLength(1);

		// The relay job runs again in attempt 2, and the retry moves the
		// failed step last, so the job goes to the other runner type.
		expect(await loop.answerRelay()).toBe("blacksmith-2vcpu-ubuntu-2404");
		const again = sim
			.jobs()
			.find((one) => one.name === "build" && one.runAttempt === 2);
		expect(again).toMatchObject({
			runId,
			status: "queued",
			labels: ["blacksmith-2vcpu-ubuntu-2404"],
		});
		expect(await loop.ledger.forRun(REPO, runId)).toHaveLength(1);
	});

	it("R12: re-running failed jobs keeps the label the relay chose and asks no relay", async () => {
		const loop = relayLoop();
		const { sim } = loop;
		const runId = loop.queueRun();
		await loop.answerRelay();
		const build = sim.claim("gh-1");
		sim.complete(build?.id ?? 0, {
			conclusion: "failure",
			steps: [
				{ name: "Set up job", conclusion: "success" },
				{ name: "Test", conclusion: "failure" },
			],
		});
		await sim.deliver(loop.handler);
		// A failing test is the job's own: no automatic retry.
		expect(loop.outcomes).toEqual([{ retried: false, reason: "own_failure" }]);
		const rerun = await sim.fetch(
			`${sim.baseUrl}/repos/${REPO}/actions/runs/${runId}/rerun-failed-jobs`,
			{ method: "POST" },
		);
		expect(rerun.status).toBe(201);
		const attempt2 = sim.jobs().filter((one) => one.runAttempt === 2);
		expect(attempt2.map((one) => [one.name, one.labels])).toEqual([
			["build", ["ubuntu-24.04"]],
		]);
		expect(loop.decisions).toHaveLength(1);
	});
});
