/**
 * A read API over the in-memory ports, seeded for two accounts: `acct-a`
 * (repositories `octo/app`, private, and `octo/site`, public) and `acct-b`
 * (`other/svc`). Token `token-a` reads as `acct-a`, `token-b` as `acct-b`,
 * and `token-write` is `acct-a` without the read scope.
 */
import { create } from "@bufbuild/protobuf";
import { RunnerRouteEventSchema } from "@hobo/ci";
import type { InsightRun } from "@hobo/ci/insights";
import {
	InMemoryInsightStore,
	InMemoryMachineRegistry,
	InMemoryMinutesReader,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testMachineAdvert,
	testRouteRequest,
} from "@hobo/ci/runner-order/testing";
import type { ControlPrincipal } from "../../src/control-auth.js";
import {
	type AccountRepository,
	createReadApi,
	type ReadApiDeps,
} from "../../src/read-api.js";

export const NOW = Date.UTC(2026, 10, 17, 12);
const HOUR = 3_600_000;

export const GITHUB_RATE = {
	usdPerMinute: 0.006,
	source: "https://docs.github.com/en/billing/reference/actions-runner-pricing",
	readOn: "2026-11-17",
} as const;

const PRINCIPALS = new Map<string, ControlPrincipal>([
	[
		"token-a",
		{ accountId: "acct-a", installationIds: [1], scopes: ["policy:read"] },
	],
	[
		"token-b",
		{ accountId: "acct-b", installationIds: [2], scopes: ["policy:read"] },
	],
	[
		"token-write",
		{ accountId: "acct-a", installationIds: [1], scopes: ["policy:write"] },
	],
]);

const REPOSITORIES = new Map<string, readonly AccountRepository[]>([
	[
		"acct-a",
		[
			{ name: "octo/app", public: false },
			{ name: "octo/site", public: true },
		],
	],
	["acct-b", [{ name: "other/svc", public: false }]],
]);

export function decided(
	accountId: string,
	repository: string,
	jobId: string,
	atMs: number,
) {
	return create(RunnerRouteEventSchema, {
		type: "runner.route.Decided",
		accountId,
		atMs,
		request: testRouteRequest(repository),
		decision: { outcome: "routed", runner: "ubuntu-24.04", step: "github" },
		mode: "relay",
		node: "relay-1",
		jobId,
	});
}

export function storedRun(
	id: number,
	repository: string,
	createdAtMs: number,
): InsightRun {
	return {
		id,
		attempt: 1,
		repository,
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		actor: "octocat",
		conclusion: "success",
		createdAtMs,
		completedAtMs: createdAtMs + 200_000,
		jobs: [
			{
				id: id * 10,
				name: "test",
				labels: ["ubuntu-24.04"],
				runnerGroup: "GitHub Actions",
				conclusion: "success",
				queuedAtMs: createdAtMs,
				startedAtMs: createdAtMs + 5_000,
				completedAtMs: createdAtMs + 185_000,
				steps: [
					{
						name: "Set up job",
						number: 1,
						conclusion: "success",
						startedAtMs: createdAtMs + 5_000,
						completedAtMs: createdAtMs + 7_000,
					},
					{
						name: "Test",
						number: 2,
						conclusion: "success",
						startedAtMs: createdAtMs + 7_000,
						completedAtMs: createdAtMs + 185_000,
					},
				],
				billed: true,
			},
			{
				id: id * 10 + 1,
				name: "lint",
				labels: ["hobo-machine-m-a"],
				conclusion: "success",
				queuedAtMs: createdAtMs,
				startedAtMs: createdAtMs + 1_000,
				completedAtMs: createdAtMs + 31_000,
				steps: [],
				billed: false,
			},
		],
	};
}

export type ReadApiFixture = Readonly<{
	handle: (request: Request) => Promise<Response | undefined>;
	journal: InMemoryRouteJournal;
	insights: InMemoryInsightStore;
	machines: InMemoryMachineRegistry;
}>;

/** The seeded read API; `stateless` leaves out the journal, machines and run history. */
export async function readApiFixture(
	stateless = false,
): Promise<ReadApiFixture> {
	const journal = new InMemoryRouteJournal();
	await journal.record(decided("acct-a", "octo/app", "job-a1", NOW - 3 * HOUR));
	await journal.record(decided("acct-a", "octo/app", "job-a2", NOW - 2 * HOUR));
	await journal.record(decided("acct-a", "octo/site", "job-a3", NOW - HOUR));
	await journal.record(decided("acct-b", "other/svc", "job-b1", NOW - HOUR));
	const machines = new InMemoryMachineRegistry();
	await machines.put(testMachineAdvert({ id: "m-a", accountId: "acct-a" }));
	await machines.put(
		testMachineAdvert({
			id: "m-b",
			accountId: "acct-b",
			ownerId: "7",
			ownerLogin: "other",
		}),
	);
	const insights = new InMemoryInsightStore();
	await insights.ingest(storedRun(101, "octo/app", NOW - 48 * HOUR));
	await insights.ingest(storedRun(102, "octo/app", NOW - 24 * HOUR));
	await insights.ingest(storedRun(103, "octo/site", NOW - 12 * HOUR));
	await insights.ingest(storedRun(201, "other/svc", NOW - 6 * HOUR));
	const deps: ReadApiDeps = {
		authenticate: (authorization) =>
			PRINCIPALS.get(authorization?.replace(/^Bearer /u, "") ?? ""),
		repositories: async (accountId) => REPOSITORIES.get(accountId) ?? [],
		order: new InMemoryRunnerOrderSource(
			new Map([
				["octo/app", '{"steps":[{"key":"machine"},{"key":"github"}]}'],
				["octo/site", '{"steps":[{"key":"nowhere"}]}'],
			]),
		),
		journal: stateless ? undefined : journal,
		machines: stateless ? undefined : machines,
		insights: stateless ? undefined : insights,
		minutes: new InMemoryMinutesReader(
			new Map([["octo", { usedMinutes: 1200, includedMinutes: 3000 }]]),
		),
		githubRate: GITHUB_RATE,
		nowMs: () => NOW,
	};
	return { handle: createReadApi(deps), journal, insights, machines };
}

/** A GET of `path` with `token` (none when empty), against the fixture. */
export async function readPath(
	fixture: ReadApiFixture,
	path: string,
	token = "token-a",
): Promise<Response> {
	const response = await fixture.handle(
		new Request(`https://relay.test${path}`, {
			headers: token === "" ? {} : { authorization: `Bearer ${token}` },
		}),
	);
	if (!response) throw new Error(`no read API route for ${path}`);
	return response;
}
