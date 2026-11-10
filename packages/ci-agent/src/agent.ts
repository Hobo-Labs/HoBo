import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	AgentEventSchema,
	type PairVerdict,
	PairVerdictSchema,
	type QueueEntry,
	type QueuePlan,
	type Resolution,
	ResolutionSchema,
} from "./_generated/agent_pb.js";
import { agentPolicies, type ParsedAgentConfig } from "./config.js";
import type { MergeWorkspace, TrialMerge } from "./git-workspace.js";
import type { AgentEventType, AgentJournal } from "./journal.js";
import { type ObservedQueue, overlappingPairs, planQueue } from "./planner.js";
import { type ResolutionEngine, resolveConflicts } from "./resolver.js";

/** Where queued work is read from. */
export interface QueueSource {
	snapshot(): Promise<ObservedQueue>;
}

/** The agent's only writes to the code host besides pushing a branch. */
export interface QueuePublisher {
	comment(number: number, body: string): Promise<void>;
	/** Ask the host's merge queue to take a pull request at exactly this commit. */
	enqueue(entry: { number: number; headSha: string }): Promise<void>;
}

export type AgentTickReport = Readonly<{
	plan: QueuePlan | undefined;
	/** Resolutions settled in this tick, in the order they were attempted. */
	resolutions: readonly Resolution[];
	enqueued: readonly number[];
	/** The branch a combined candidate was pushed to, if one was. */
	rollupRef: string | undefined;
	/** Steps that failed and were skipped; the tick itself still completed. */
	failures: number;
}>;

/** A report while its tick is still running. */
type TickProgress = {
	plan: QueuePlan | undefined;
	resolutions: Resolution[];
	enqueued: number[];
	rollupRef: string | undefined;
	failures: number;
};

const sha256 = (value: readonly (string | number)[]) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quoted = (path: string) => `\`${path.replace(/[`\r\n]/g, "'")}\``;

/**
 * The agent: one `tick` observes the queue, plans it, resolves what it may,
 * and publishes as far as its mode allows.
 *
 * It never merges. A resolution is a commit on the pull request's own branch
 * (apply) or on a `hobo-agent/` branch (suggest), and it reaches the base
 * branch only through the repository's required checks and merge queue like
 * any other commit. Nothing a model returns is a merge condition.
 */
export function createCiAgent(options: {
	config: ParsedAgentConfig;
	queue: QueueSource;
	publisher: QueuePublisher;
	workspace: MergeWorkspace;
	engines: readonly ResolutionEngine[];
	journal: AgentJournal;
	now?: (() => string) | undefined;
}) {
	const { config, workspace, journal, publisher } = options;
	const policy = agentPolicies(config);
	const now = options.now ?? (() => new Date().toISOString());
	const policyDigest = sha256([
		JSON.stringify(policy.resolution),
		...config.engines.flatMap((engine) => [
			engine.id,
			engine.kind,
			engine.model,
		]),
	]);
	const trials = new Map<string, TrialMerge>();
	const enqueueAskedAt = new Map<string, number>();

	async function trial(ours: string, theirs: string): Promise<TrialMerge> {
		const key = `${ours}:${theirs}`;
		const cached = trials.get(key);
		if (cached) return cached;
		const result = await workspace.trial(ours, theirs);
		if (trials.size >= 500) trials.clear();
		trials.set(key, result);
		return result;
	}
	async function record(
		repository: string,
		type: AgentEventType,
		body: { plan?: QueuePlan; resolution?: Resolution; numbers?: number[] },
	) {
		await journal.append(
			create(AgentEventSchema, {
				id: randomUUID(),
				type,
				at: now(),
				repository,
				...body,
			}),
		);
	}

	/**
	 * Merge `theirs` into `ours`, resolving conflicts, at most once per pair of
	 * commits and policy. Returns nothing when today's budget is spent, so the
	 * merge is tried again tomorrow instead of being recorded as declined.
	 */
	async function settle(input: {
		repository: string;
		number: number;
		ours: string;
		theirs: string;
		oursLabel: string;
		theirsLabel: string;
	}): Promise<{ resolution: Resolution; fresh: boolean } | undefined> {
		const { repository, ours, theirs } = input;
		const key = sha256([repository, ours, theirs, policyDigest]);
		const existing = await journal.settled(key);
		if (existing) return { resolution: existing, fresh: false };
		const merge = await trial(ours, theirs);
		const day = `${now().slice(0, 10)}T00:00:00.000Z`;
		const result = await resolveConflicts({
			files: merge.files,
			policy: policy.resolution,
			budget: policy.budget,
			engines: options.engines,
			remainingTokens:
				Number(policy.budget.maxTokensPerDay) -
				(await journal.tokensSince(day)),
			oursLabel: input.oursLabel,
			theirsLabel: input.theirsLabel,
		});
		if (result.outcome !== "resolved" && result.reason === "daily-budget") {
			const last = await journal.latest(repository, "ci.agent.BudgetExhausted");
			if (!last || last.at < day)
				await record(repository, "ci.agent.BudgetExhausted", {});
			return undefined;
		}
		const files = result.outcome === "resolved" ? result.files : [];
		const commitSha =
			result.outcome === "resolved"
				? await workspace.commit({
						tree: merge.tree,
						parents: [ours, theirs],
						files: new Map(files.map((file) => [file.path, file.content])),
						message: [
							`Merge ${input.theirsLabel} into ${input.oursLabel}`,
							"",
							`Conflicts in ${files.length} file(s) were resolved by hobo-ci-agent:`,
							...files.map(
								(file) => `- ${file.path} (${file.regions} region(s))`,
							),
							"",
							"This merge was written by an automated agent and has not been reviewed.",
							"The required checks on this commit are its verification.",
							"",
							`Hobo-Agent-Resolution: ${key}`,
							`Hobo-Agent-Engine: ${result.engineId} (${result.model})`,
							"",
						].join("\n"),
					})
				: "";
		const resolution = create(ResolutionSchema, {
			key,
			repository,
			number: input.number,
			oursSha: ours,
			theirsSha: theirs,
			outcome: result.outcome,
			reason: result.outcome === "resolved" ? "" : result.reason,
			files: files.map((file) => ({
				path: file.path,
				regions: file.regions,
				confidence: file.confidence,
				contentSha256: file.contentSha256,
			})),
			engineId: result.engineId,
			model: result.model,
			usage: {
				inputTokens: BigInt(result.usage.inputTokens),
				outputTokens: BigInt(result.usage.outputTokens),
			},
			commitSha,
		});
		await record(repository, "ci.agent.ResolutionSettled", { resolution });
		return { resolution, fresh: true };
	}

	return {
		async tick(): Promise<AgentTickReport> {
			const snapshot = await options.queue.snapshot();
			const { repository, baseSha, baseRef } = snapshot;
			const entries = snapshot.entries.slice(0, policy.queue.maxDepth);
			const report: TickProgress = {
				plan: undefined,
				resolutions: [],
				enqueued: [],
				rollupRef: undefined,
				failures: 0,
			};
			if (entries.length === 0) return report;
			const attempt = async <T>(step: () => Promise<T>) => {
				try {
					return await step();
				} catch {
					report.failures++;
					return undefined;
				}
			};
			await workspace.fetch([
				`refs/heads/${baseRef}`,
				...entries.map((entry) => `refs/pull/${entry.number}/head`),
			]);

			const baseConflicts = new Map<number, readonly string[]>();
			for (const entry of entries) {
				const merge = await attempt(() => trial(entry.headSha, baseSha));
				if (merge && !merge.clean)
					baseConflicts.set(
						entry.number,
						merge.files.map((file) => file.path),
					);
			}
			const verdicts: PairVerdict[] = [];
			for (const [first, second] of overlappingPairs(entries)) {
				const merge = await attempt(() => trial(first.headSha, second.headSha));
				verdicts.push(
					create(PairVerdictSchema, {
						first: first.number,
						second: second.number,
						verdict: !merge ? "unknown" : merge.clean ? "clean" : "conflict",
						paths: merge?.files.map((file) => file.path) ?? [],
					}),
				);
			}
			const plan = planQueue({
				snapshot,
				verdicts,
				baseConflicts,
				policy: policy.queue,
			});
			report.plan = plan;
			const proposed = await journal.latest(
				repository,
				"ci.agent.PlanProposed",
			);
			if (proposed?.plan?.digest !== plan.digest)
				await record(repository, "ci.agent.PlanProposed", { plan });

			const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
			const ordered = plan.order.flatMap(
				(number) => byNumber.get(number) ?? [],
			);
			let started = 0;
			const settleFresh = async (input: Parameters<typeof settle>[0]) => {
				if (started >= policy.budget.maxResolutionsPerTick) return undefined;
				const settled = await attempt(() => settle(input));
				if (settled?.fresh) {
					started++;
					report.resolutions.push(settled.resolution);
				}
				return settled;
			};
			const publish = async (
				entry: QueueEntry,
				resolution: Resolution,
				ref: string,
				type: "ci.agent.ResolutionPublished" | "ci.agent.RollupPublished",
				body: string,
				numbers: number[],
			) => {
				// The base branch only ever moves through the host's own merge.
				if (ref === `refs/heads/${baseRef}`) throw new Error("refused git ref");
				await workspace.push(resolution.commitSha, ref);
				const published = create(ResolutionSchema, {
					...resolution,
					publishedRef: ref,
				});
				await record(repository, type, { resolution: published, numbers });
				for (const number of numbers)
					await attempt(() => publisher.comment(number, body));
				return entry;
			};

			// A pull request that no longer merges onto its base branch.
			for (const entry of ordered) {
				if (!baseConflicts.has(entry.number)) continue;
				const settled = await settleFresh({
					repository,
					number: entry.number,
					ours: entry.headSha,
					theirs: baseSha,
					oursLabel: `pull request #${entry.number}`,
					theirsLabel: baseRef,
				});
				const resolution = settled?.resolution;
				if (
					!settled?.fresh ||
					resolution?.outcome !== "resolved" ||
					config.mode === "observe"
				)
					continue;
				const direct = config.mode === "apply" && !entry.fork;
				const ref = direct
					? `refs/heads/${entry.headRef}`
					: `refs/heads/hobo-agent/resolve/${entry.number}-${entry.headSha.slice(0, 8)}`;
				const files = resolution.files.map((file) => quoted(file.path));
				await attempt(() =>
					publish(
						entry,
						resolution,
						ref,
						"ci.agent.ResolutionPublished",
						[
							`**hobo-ci-agent** resolved the merge conflicts between this pull request and ${quoted(baseRef)} in ${files.join(", ")}.`,
							"",
							direct
								? `The merge commit ${resolution.commitSha} was pushed to this branch. It was written by a model (${quoted(resolution.model)}) and has not been reviewed: read the diff, and treat the required checks on it as the verification.`
								: `The proposed merge commit ${resolution.commitSha} is on ${quoted(ref.slice(11))}. Nothing on this branch was changed. To take it, review that commit and fast-forward this branch to it.`,
						].join("\n"),
						[entry.number],
					),
				);
			}

			// Feed the host's merge queue in planned order.
			if (config.mode === "apply") {
				const queued = new Set(
					entries.filter((entry) => entry.started).map((entry) => entry.number),
				);
				for (const entry of ordered) {
					if (report.enqueued.length >= policy.queue.maxBatchSize) break;
					const key = `${entry.number}:${entry.headSha}`;
					if (
						entry.started ||
						baseConflicts.has(entry.number) ||
						entry.dependsOn.some((parent) => !queued.has(parent)) ||
						Date.parse(now()) - (enqueueAskedAt.get(key) ?? 0) < 600_000
					)
						continue;
					// Asked once per commit and ten minutes, whatever the answer: the
					// host's queue can lag behind an accepted request, and it refuses
					// a pull request that is not yet mergeable.
					enqueueAskedAt.set(key, Date.parse(now()));
					try {
						await publisher.enqueue(entry);
						await record(repository, "ci.agent.EntryEnqueued", {
							numbers: [entry.number],
						});
						queued.add(entry.number);
						report.enqueued.push(entry.number);
					} catch {
						report.failures++;
					}
				}
			}

			// One candidate branch carrying several waiting pull requests.
			if (config.mode === "suggest" && policy.queue.rollup) {
				const candidates = ordered
					.filter((entry) => !entry.started)
					.slice(0, policy.queue.maxBatchSize);
				const key = sha256([
					repository,
					"rollup",
					baseSha,
					...candidates.map((entry) => entry.headSha),
					policyDigest,
				]);
				if (candidates.length > 1 && !(await journal.settled(key))) {
					let tip = baseSha;
					const included: QueueEntry[] = [];
					for (const entry of candidates) {
						const present = new Set(included.map((member) => member.number));
						if (entry.dependsOn.some((parent) => !present.has(parent)))
							continue;
						const parent = tip;
						const merge = await attempt(() => trial(parent, entry.headSha));
						if (!merge) continue;
						let commit: string | undefined;
						if (merge.clean)
							commit = await attempt(() =>
								workspace.commit({
									tree: merge.tree,
									parents: [parent, entry.headSha],
									files: new Map(),
									message: `Merge pull request #${entry.number} into combined candidate\n`,
								}),
							);
						else {
							const settled = await settleFresh({
								repository,
								number: entry.number,
								ours: parent,
								theirs: entry.headSha,
								oursLabel: "combined candidate",
								theirsLabel: `pull request #${entry.number}`,
							});
							if (settled?.resolution.outcome === "resolved")
								commit = settled.resolution.commitSha;
						}
						if (!commit) continue;
						tip = commit;
						included.push(entry);
					}
					const last = included.at(-1);
					if (included.length > 1 && last) {
						const ref = `refs/heads/hobo-agent/rollup/${key.slice(0, 12)}`;
						const numbers = included.map((entry) => entry.number);
						const published = await attempt(() =>
							publish(
								last,
								create(ResolutionSchema, {
									key,
									repository,
									oursSha: baseSha,
									theirsSha: last.headSha,
									outcome: "resolved",
									commitSha: tip,
								}),
								ref,
								"ci.agent.RollupPublished",
								[
									`**hobo-ci-agent** combined ${numbers.map((number) => `#${number}`).join(", ")} on ${quoted(ref.slice(11))} (${tip}), on top of ${quoted(baseRef)}.`,
									"",
									"Conflicts between them were resolved by a model and have not been reviewed. Nothing on this branch was changed, and nothing was merged: open a pull request from that branch to run the required checks on the combination.",
								].join("\n"),
								numbers,
							),
						);
						if (published) report.rollupRef = ref;
					}
				}
			}
			return report;
		},
	};
}

export type CiAgent = ReturnType<typeof createCiAgent>;
