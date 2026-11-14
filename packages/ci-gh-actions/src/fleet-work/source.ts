/**
 * The dispatcher half of `github-actions-job` (design §6.9 table): GitHub's
 * queue, read by the existing poller (`github-job-poller.ts`, unchanged),
 * becomes upstream work. Each queued job is described from its run (author,
 * origin, ref, workflow digest) and sized by the worker's memory and storage
 * classes; `prepare` mints one just-in-time runner registration for the
 * claimant, which is the order's sealed secret. Private to L16.
 */
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import {
	type FleetRecord,
	type MemberRecord,
	type Outcome,
	type UpstreamWork,
	WorkNeedsSchema,
	type WorkOffer,
	type WorkSource,
} from "@hobo/fleet";
import { z } from "zod";
import type { GithubTransport } from "../github.js";
import { createGithubJobPoller } from "../isolated-worker/github-job-poller.js";
import {
	memoryRequestForJob,
	resolveWorkerMemoryConfig,
} from "../isolated-worker/memory-classes.js";
import { storageReserveForJob } from "../isolated-worker/storage-job-classes.js";
import {
	jitRunnerRegistrationLabels,
	RUNNER_LABEL,
	servedRunnerLabel,
} from "../runner-labels.js";
import type { GithubWorkOptions } from "./index.js";
import { GITHUB_ACTIONS_JOB } from "./kind.js";
import { originOf, PULL_REQUEST_EVENTS } from "./origin.js";
import { GITHUB_EGRESS, GITHUB_RUNNER_IMAGE } from "./runner.js";

const MIB = 1024 * 1024;
/** Prepared work is not offered again for this long while GitHub still lists it queued. */
const PREPARED_HOLD_MS = 10 * 60_000;
/** Run descriptions kept; a run's facts do not change within one attempt. */
const RUN_CACHE = 512;

/** The worker's default memory classes (no environment, an unbounded host): the size an offer asks for. */
const SIZING = resolveWorkerMemoryConfig(
	{},
	{ totalMemoryMb: 1_048_576, trunkSlots: 0 },
);

/** The body the poller hands its intake, as `github-job-poller.ts` builds it. */
const Delivery = z.object({
	action: z.string(),
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({
		id: z.number().int().positive(),
		full_name: z.string(),
	}),
	workflow_job: z.object({
		id: z.number().int().positive(),
		run_id: z.number().int().positive(),
		run_attempt: z.number().int().positive(),
		labels: z.array(z.string()),
		name: z.string().optional(),
		created_at: z.string().optional(),
		runner_name: z.string().nullable(),
	}),
});

const Actor = z
	.object({ id: z.number().int().positive() })
	.nullable()
	.optional();
const RunFacts = z.object({
	event: z.string(),
	head_branch: z.string().nullable().optional(),
	head_sha: z.string(),
	path: z.string(),
	actor: Actor,
	triggering_actor: Actor,
	repository: z.object({ full_name: z.string() }),
	head_repository: z.object({ full_name: z.string() }).nullable().optional(),
	pull_requests: z
		.array(z.object({ number: z.number().int().positive() }))
		.optional(),
});
type RunFacts = z.infer<typeof RunFacts>;

const Contents = z.object({
	content: z.string(),
	encoding: z.literal("base64"),
});
const JobState = z.object({
	status: z.string(),
	runner_name: z.string().nullable().optional(),
});

type Queued = {
	readonly work: UpstreamWork;
	readonly installationId: number;
	readonly jobId: number;
	preparedUntilMs: number;
};

type Seen = Readonly<{
	installationId: number;
	repository: string;
	jobId: number;
	runId: number;
	attempt: number;
	name: string;
	label: string;
	createdAt: string | undefined;
}>;

function workKeyOf(repository: string, jobId: number, attempt: number): string {
	return `${repository}#${jobId}@${attempt}`;
}

function refOf(run: RunFacts): string {
	const pull = run.pull_requests?.[0];
	if (
		pull !== undefined &&
		PULL_REQUEST_EVENTS.includes(run.event) &&
		run.event !== "pull_request_target"
	)
		return `refs/pull/${pull.number}/merge`;
	return `refs/heads/${run.head_branch ?? ""}`;
}

function authorOf(run: RunFacts): string {
	const id = run.triggering_actor?.id ?? run.actor?.id;
	return id === undefined ? "" : `github:${id}`;
}

function sizeOf(name: string, label: string) {
	const memory = memoryRequestForJob(name, SIZING);
	return create(WorkNeedsSchema, {
		memoryMb: memory.memoryMb,
		diskMb: Math.ceil(storageReserveForJob(name).workRootBytes / MIB),
		labels: [label],
		platform: { os: "linux" },
	});
}

/** GitHub runner names: letters, digits, `.`, `_` and `-`, at most 64. */
function runnerNameFor(claimant: MemberRecord, offer: WorkOffer): string {
	const member = claimant.memberId.replace(/[^A-Za-z0-9._-]/gu, "-").slice(-16);
	return `hobo-fleet-${member}-${offer.workDigest.slice(0, 12)}`.slice(0, 64);
}

async function readJson<T>(
	github: GithubTransport,
	installationId: number,
	path: string,
	schema: z.ZodType<T>,
): Promise<T | undefined> {
	try {
		const response = await github.request(installationId, path);
		if (!response.ok) return undefined;
		const parsed = schema.safeParse(await response.json());
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function parseBody(bytes: Uint8Array): JsonValue | undefined {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

export function githubActionsSource(options: GithubWorkOptions): WorkSource {
	const github = options.poller.github;
	let seen: Seen[] = [];
	const poller = createGithubJobPoller({
		...options.poller,
		now: options.poller.now ?? options.now,
		async ingest(delivery) {
			const parsed = Delivery.safeParse(parseBody(delivery.rawBody));
			const job = parsed.success ? parsed.data.workflow_job : undefined;
			const label =
				job === undefined ? undefined : servedRunnerLabel(job.labels);
			if (
				parsed.success &&
				job !== undefined &&
				label !== undefined &&
				parsed.data.action === "queued" &&
				job.runner_name === null
			)
				seen.push({
					installationId: parsed.data.installation.id,
					repository: parsed.data.repository.full_name,
					jobId: job.id,
					runId: job.run_id,
					attempt: job.run_attempt,
					name: job.name ?? "",
					label,
					createdAt: job.created_at,
				});
			return options.poller.ingest(delivery);
		},
	});
	const queued = new Map<string, Queued>();
	const runs = new Map<string, RunFacts>();
	const digests = new Map<string, string>();

	async function describeRun(job: Seen): Promise<RunFacts | undefined> {
		const key = `${job.repository}#${job.runId}@${job.attempt}`;
		const cached = runs.get(key);
		if (cached !== undefined) return cached;
		const run = await readJson(
			github,
			job.installationId,
			`/repos/${job.repository}/actions/runs/${job.runId}`,
			RunFacts,
		);
		if (run === undefined) return undefined;
		runs.set(key, run);
		for (const old of runs.keys()) {
			if (runs.size <= RUN_CACHE) break;
			runs.delete(old);
		}
		return run;
	}

	/** `sha256:<hex>` of the workflow file at the run's commit; empty when GitHub will not give it. */
	async function workflowDigest(job: Seen, run: RunFacts): Promise<string> {
		const key = `${job.repository}:${run.path}@${run.head_sha}`;
		const cached = digests.get(key);
		if (cached !== undefined) return cached;
		const file = await readJson(
			github,
			job.installationId,
			`/repos/${job.repository}/contents/${run.path}?ref=${run.head_sha}`,
			Contents,
		);
		if (file === undefined) return "";
		const digest = `sha256:${createHash("sha256")
			.update(Buffer.from(file.content, "base64"))
			.digest("hex")}`;
		digests.set(key, digest);
		for (const old of digests.keys()) {
			if (digests.size <= RUN_CACHE) break;
			digests.delete(old);
		}
		return digest;
	}

	let inflight: Promise<void> | undefined;
	/** One poll at a time; a caller arriving while one runs shares it. */
	function refresh(): Promise<void> {
		inflight ??= pollOnce().finally(() => {
			inflight = undefined;
		});
		return inflight;
	}

	async function pollOnce(): Promise<void> {
		seen = [];
		const summary = await poller.poll();
		const found = seen;
		seen = [];
		// A poll cut short by GitHub's rate limit knows less than the last one.
		if (summary.pausedUntil !== undefined) return;
		const waiting = new Set(summary.waiting.map((job) => job.jobId));
		const next = new Map<string, Queued>();
		for (const job of found) {
			const key = workKeyOf(job.repository, job.jobId, job.attempt);
			const known = queued.get(key);
			if (known !== undefined) {
				next.set(key, known);
				continue;
			}
			const run = await describeRun(job);
			if (run === undefined) continue;
			const createdAt = Date.parse(job.createdAt ?? "");
			next.set(key, {
				installationId: job.installationId,
				jobId: job.jobId,
				preparedUntilMs: 0,
				work: {
					workKey: key,
					label: job.label,
					needs: sizeOf(job.name, job.label),
					author: authorOf(run),
					origin: originOf(
						run.event,
						job.repository,
						run.head_repository?.full_name,
					),
					repository: job.repository,
					ref: refOf(run),
					workflowDigest: await workflowDigest(job, run),
					queuedAtMs: Number.isFinite(createdAt) ? createdAt : options.now(),
				},
			});
		}
		// A job the poll saw but did not hand its intake (coalesced, deferred) is still queued.
		for (const [key, entry] of queued)
			if (!next.has(key) && waiting.has(entry.jobId)) next.set(key, entry);
		queued.clear();
		for (const [key, entry] of next) queued.set(key, entry);
	}

	return {
		kind: GITHUB_ACTIONS_JOB,
		async poll(fleet: FleetRecord): Promise<readonly UpstreamWork[]> {
			await refresh();
			const repositories = new Set(
				(fleet.policy?.repositories ?? []).map((rule) =>
					rule.repository.toLowerCase(),
				),
			);
			const labels = fleet.policy?.labels ?? [];
			const nowMs = options.now();
			return [...queued.values()]
				.filter(
					(entry) =>
						entry.preparedUntilMs <= nowMs &&
						repositories.has(entry.work.repository.toLowerCase()) &&
						(labels.length === 0 || labels.includes(entry.work.label)),
				)
				.map((entry) => entry.work);
		},
		async prepare(offer, claimant) {
			const entry = queued.get(offer.workKey);
			if (entry === undefined || entry.work.repository !== offer.repository)
				return {
					ok: false,
					error: {
						code: "work-unknown",
						message: "GitHub no longer lists that job as queued here",
					},
				};
			const primary = servedRunnerLabel([offer.label]) ?? RUNNER_LABEL;
			const runnerName = runnerNameFor(claimant, offer);
			const minted: Outcome<Uint8Array> = await options.mintRegistration({
				repository: offer.repository,
				labels: jitRunnerRegistrationLabels([offer.label], primary),
				runnerName,
			});
			if (!minted.ok) {
				options.log("hobo_fleet_offer_unfit", {
					digest: offer.workDigest,
					reason: `registration-${minted.error.code}`,
				});
				return minted;
			}
			entry.preparedUntilMs = options.now() + PREPARED_HOLD_MS;
			return {
				ok: true,
				value: {
					parameters: {
						image: GITHUB_RUNNER_IMAGE,
						runnerName,
						label: offer.label,
					},
					secret: minted.value,
					egressAllow: [...GITHUB_EGRESS],
				},
			};
		},
		async stillWanted(offer) {
			const entry = queued.get(offer.workKey);
			if (entry === undefined) return false;
			const state = await readJson(
				github,
				entry.installationId,
				`/repos/${entry.work.repository}/actions/jobs/${entry.jobId}`,
				JobState,
			);
			// GitHub not answering must not strand the queue: the runner it gets is idle at worst.
			if (state === undefined) return true;
			return state.status === "queued" && !state.runner_name;
		},
	};
}
