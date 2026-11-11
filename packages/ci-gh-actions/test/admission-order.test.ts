import { expect, it } from "vitest";
import {
	admissionRank,
	createAdmissionOrder,
	TRUNK_RANK,
} from "../src/admission-order.js";
import type { GithubTransport } from "../src/github.js";
import { run } from "./fixtures.js";

/** The run fields admission reads; a run id with no entry answers 404. */
type RunEntry = Readonly<{ event: string; startedAt: string | null }>;

function transport(runs: ReadonlyMap<number, RunEntry>) {
	const calls: number[] = [];
	const github: GithubTransport = {
		async request(_installation, path) {
			const id = Number(path.split("/").at(-1));
			calls.push(id);
			const entry = runs.get(id);
			if (!entry) return new Response(null, { status: 404 });
			return Response.json({
				...run(),
				id,
				event: entry.event,
				run_started_at: entry.startedAt,
			});
		},
	};
	return { github, calls };
}

const ref = (runId: number, jobId = runId) => ({
	installationId: 10,
	repository: "org/repo",
	runId,
	jobId,
});

it("ranks merge-queue and trunk runs ahead of pull requests and sweeps", () => {
	expect(admissionRank("merge_group")).toBe(0);
	expect(admissionRank("push")).toBe(0);
	expect(admissionRank("workflow_dispatch")).toBe(0);
	expect(admissionRank("pull_request")).toBe(1);
	expect(admissionRank("pull_request_target")).toBe(1);
	expect(admissionRank("schedule")).toBe(2);
});

it("orders by rank, then the oldest run, then the job id", async () => {
	const { github } = transport(
		new Map([
			[1, { event: "pull_request", startedAt: "2026-10-26T12:00:00Z" }],
			[2, { event: "merge_group", startedAt: "2026-10-26T12:05:00Z" }],
			[3, { event: "push", startedAt: "2026-10-26T12:01:00Z" }],
			[4, { event: "schedule", startedAt: "2026-10-26T11:00:00Z" }],
			[5, { event: "pull_request", startedAt: "2026-10-26T11:59:00Z" }],
		]),
	);
	const order = createAdmissionOrder(github);
	const items = [ref(1), ref(4), ref(2, 21), ref(5), ref(2, 20), ref(3)];
	expect(
		(await order(items, (item) => item)).map((item) => item.jobId),
	).toEqual([20, 21, 3, 5, 1, 4]);
});

it("looks each run up once and retries a failed lookup next tick", async () => {
	const runs = new Map<number, RunEntry>([
		[1, { event: "pull_request", startedAt: "2026-10-26T12:00:00Z" }],
	]);
	const { github, calls } = transport(runs);
	const order = createAdmissionOrder(github);
	const items = [ref(2), ref(1), ref(1, 11)];
	// The unknown run waits behind the pull request it cannot be ranked against.
	expect(
		(await order(items, (item) => item)).map((item) => item.jobId),
	).toEqual([1, 11, 2]);
	runs.set(2, { event: "merge_group", startedAt: "2026-10-26T12:10:00Z" });
	expect(
		(await order(items, (item) => item)).map((item) => item.jobId),
	).toEqual([2, 1, 11]);
	expect(calls).toEqual([2, 1, 2]);
});

it("exposes the primed head sha for a run", async () => {
	const { github } = transport(new Map());
	const order = createAdmissionOrder(github);
	order.prime({
		runId: 9,
		event: "push",
		runStartedAt: "2026-10-26T12:00:00Z",
		headSha: "a".repeat(40),
	});
	expect(await order.headSha(ref(9))).toBe("a".repeat(40));
});

it("ranks the trunk-only label ahead of pull requests when run lookups fail", async () => {
	const { github } = transport(
		new Map([
			[1, { event: "pull_request", startedAt: "2026-10-26T12:00:00Z" }],
		]),
	);
	const order = createAdmissionOrder(github);
	const trunk = { ...ref(2), labels: ["hobo-trunk"] };
	const general = { ...ref(3), labels: ["hobo"] };
	expect(
		(await order([general, ref(1), trunk], (item) => item)).map(
			(item) => item.jobId,
		),
	).toEqual([2, 1, 3]);
	expect(await order.rank(trunk)).toBe(TRUNK_RANK);
	expect(await order.rank(general)).toBe(1);
});

it("orders main workspace shards by index within a run before duration ties", async () => {
	const { github } = transport(
		new Map([[1, { event: "push", startedAt: "2026-10-26T12:00:00Z" }]]),
	);
	const expected = new Map([
		[100, 200_000],
		[101, 50_000],
		[102, 150_000],
	]);
	const order = createAdmissionOrder(github, {
		expectedMs: (_repository, jobId) => expected.get(jobId) ?? 0,
	});
	const shard = (jobId: number, index: number) => ({
		...ref(1, jobId),
		jobName: `Main workspace test shard ${index}`,
	});
	expect(
		(await order([shard(100, 2), shard(101, 0), shard(102, 1)], (item) => item))
			.map((item) => item.jobId),
	).toEqual([101, 102, 100]);
});

it("admits a run's longest expected job first, inside the rank and run order", async () => {
	const { github } = transport(
		new Map([
			[1, { event: "push", startedAt: "2026-10-26T12:00:00Z" }],
			[2, { event: "push", startedAt: "2026-10-26T12:05:00Z" }],
			[3, { event: "pull_request", startedAt: "2026-10-26T11:00:00Z" }],
		]),
	);
	const expected = new Map([
		[11, 14_000],
		[12, 85_000],
		[13, 32_000],
		[21, 600_000],
		[31, 900_000],
	]);
	const order = createAdmissionOrder(github, {
		expectedMs: (_repository, jobId) => expected.get(jobId) ?? 0,
	});
	const items = [
		ref(3, 31),
		ref(2, 21),
		ref(1, 14),
		ref(1, 11),
		ref(1, 13),
		ref(1, 12),
	];
	// Newer push run 2 leads the older run 1; both outrank the pull request.
	// Inside run 1, the 85 s job leads and the job with no history (14) goes last.
	expect(
		(await order(items, (item) => item)).map((item) => item.jobId),
	).toEqual([21, 12, 13, 11, 14, 31]);
});

it("puts a run with no start time behind started runs of the same rank", async () => {
	const { github } = transport(
		new Map([
			[1, { event: "push", startedAt: null }],
			[2, { event: "push", startedAt: "2026-10-26T12:10:00Z" }],
		]),
	);
	const order = createAdmissionOrder(github);
	expect(
		(await order([ref(1), ref(2)], (item) => item)).map((item) => item.jobId),
	).toEqual([2, 1]);
});

it("looks a run up again until GitHub gives it a start time", async () => {
	const runs = new Map<number, RunEntry>([
		[1, { event: "push", startedAt: null }],
	]);
	const { github, calls } = transport(runs);
	const order = createAdmissionOrder(github);
	expect(await order.rank(ref(1))).toBe(0);
	runs.set(1, { event: "push", startedAt: "2026-10-26T12:10:00Z" });
	expect(await order.rank(ref(1))).toBe(0);
	expect(await order.rank(ref(1))).toBe(0);
	expect(calls).toEqual([1, 1]);
});

it("keeps a seen trunk rank when the next lookup fails", async () => {
	const runs = new Map<number, RunEntry>([
		[1, { event: "push", startedAt: null }],
		[2, { event: "pull_request", startedAt: "2026-10-26T12:00:00Z" }],
	]);
	const { github } = transport(runs);
	const order = createAdmissionOrder(github);
	expect(await order.rank(ref(1))).toBe(0);
	runs.delete(1);
	expect(
		(await order([ref(2), ref(1)], (item) => item)).map((item) => item.jobId),
	).toEqual([1, 2]);
});

it("does not sort merge_group jobs by run started time before queue positions exist", async () => {
	const runs = new Map([
		[1, { event: "merge_group", startedAt: "2026-10-26T14:00:00Z" }],
		[2, { event: "merge_group", startedAt: "2026-10-26T11:00:00Z" }],
	]);
	const { github } = transport(runs);
	const order = createAdmissionOrder(github, undefined, () => undefined);
	expect(
		(await order([ref(1), ref(2)], (item) => item)).map((item) => item.runId),
	).toEqual([1, 2]);
});

it("orders merge_group jobs by merge queue position and deprioritizes stale heads", async () => {
	const runs = new Map([
		[10, { event: "merge_group", startedAt: "2026-10-26T14:00:00Z" }],
		[20, { event: "merge_group", startedAt: "2026-10-26T12:00:00Z" }],
		[30, { event: "merge_group", startedAt: "2026-10-26T11:00:00Z" }],
	]);
	const { github } = transport(runs);
	const order = createAdmissionOrder(github, undefined, () => ({
		byHeadSha: new Map([
			["a".repeat(40), 1],
			["b".repeat(40), 2],
		]),
		fetchedAtMs: Date.now(),
	}));
	order.prime({
		runId: 10,
		event: "merge_group",
		runStartedAt: "2026-10-26T14:00:00Z",
		headSha: "a".repeat(40),
	});
	order.prime({
		runId: 20,
		event: "merge_group",
		runStartedAt: "2026-10-26T12:00:00Z",
		headSha: "b".repeat(40),
	});
	order.prime({
		runId: 30,
		event: "merge_group",
		runStartedAt: "2026-10-26T11:00:00Z",
		headSha: "c".repeat(40),
	});
	const items = [ref(30), ref(10, 101), ref(20), ref(10, 100)];
	expect(
		(await order(items, (item) => item)).map((item) => item.jobId),
	).toEqual([100, 101, 20, 30]);
});

it("uses primed run data without another GitHub request", async () => {
	const { github, calls } = transport(
		new Map([
			[2, { event: "pull_request", startedAt: "2026-10-26T12:00:00Z" }],
		]),
	);
	const order = createAdmissionOrder(github);
	order.prime({
		runId: 1,
		event: "push",
		runStartedAt: "2026-10-26T12:10:00Z",
	});
	expect(
		(await order([ref(2), ref(1)], (item) => item)).map((item) => item.jobId),
	).toEqual([1, 2]);
	expect(calls).toEqual([2]);
});
