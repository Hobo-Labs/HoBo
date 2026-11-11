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
import { parseMergeSegments, regionTexts } from "./conflict.js";
import type { MergeWorkspace, TrialMerge } from "./git-workspace.js";
import {
	type AgentEventType,
	type AgentJournal,
	checkedKey,
	ejectedKey,
	enqueuedKey,
	publishedKey,
} from "./journal.js";
import {
	createVerdicts,
	type ObservedQueue,
	overlappingPairs,
	planQueue,
} from "./planner.js";
import {
	type EngineFailure,
	type PreviousAttempt,
	type ResolutionEngine,
	resolveConflicts,
} from "./resolver.js";
import type { StructuredMerger } from "./structured-merge.js";

/** Where queued work is read from. */
export interface QueueSource {
	snapshot(): Promise<ObservedQueue>;
	/**
	 * Whether the host confirms that the base branch requires status checks
	 * before a merge. Only asked in apply mode. Anything short of a confirmed
	 * yes, including a failed lookup, is treated as no.
	 */
	baseRequiresChecks(): Promise<boolean>;
	/** The repository's checks on a commit the agent published. */
	commitChecks(sha: string): Promise<CommitChecks>;
}

/**
 * Where a commit's checks stand. `failures` is bounded CI output, for a
 * prompt. `infrastructure` is a failure no change to the code can fix (a
 * timeout, a runner that did not start, a cancelled run): the agent waits for
 * a re-run instead of repairing.
 */
export type CommitChecks = Readonly<{
	state: "pending" | "success" | "failure" | "infrastructure" | "none";
	failures: string;
}>;

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
	/**
	 * Apply mode was configured, but the base branch was not confirmed to
	 * require status checks, so this pass only suggested.
	 */
	applyWithheld: boolean;
	/** Entries the merge queue ejected at their current commit, noticed this pass. */
	ejected: readonly number[];
	/** Steps that failed and were skipped; the tick itself still completed. */
	failures: number;
	/** Each time an engine gave no usable answer, and why. */
	engineFailures: readonly EngineFailure[];
}>;

/** A report while its tick is still running. */
type TickProgress = {
	plan: QueuePlan | undefined;
	resolutions: Resolution[];
	enqueued: number[];
	rollupRef: string | undefined;
	applyWithheld: boolean;
	ejected: number[];
	failures: number;
	engineFailures: EngineFailure[];
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
	/** Set when `resolution.structuredMerge` is on. */
	structured?: StructuredMerger | undefined;
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
	const startOfDay = () => `${now().slice(0, 10)}T00:00:00.000Z`;
	async function record(
		repository: string,
		type: AgentEventType,
		body: {
			plan?: QueuePlan;
			resolution?: Resolution;
			numbers?: number[];
			headSha?: string;
			checksState?: string;
		},
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
	/** Engine failures of the tick in progress; ticks never overlap. */
	let engineFailures: EngineFailure[] = [];

	async function settle(input: {
		repository: string;
		number: number;
		ours: string;
		theirs: string;
		oursLabel: string;
		theirsLabel: string;
		/** Correct an earlier resolution whose checks failed, on top of its commit. */
		repair?: { of: Resolution; failures: string } | undefined;
	}): Promise<{ resolution: Resolution; fresh: boolean } | undefined> {
		const { repository, ours, theirs, repair } = input;
		const key = repair
			? sha256([repair.of.key, "repair", policyDigest])
			: sha256([repository, ours, theirs, policyDigest]);
		const existing = await journal.settled(key);
		if (existing) return { resolution: existing, fresh: false };
		const merge = await trial(ours, theirs);
		// What the failed attempt put in each region, recovered from its commit.
		const previous = new Map<string, PreviousAttempt>();
		if (repair)
			for (const file of merge.files) {
				if (file.kind !== "content") continue;
				const committed = await workspace.read(repair.of.commitSha, file.path);
				let texts: ReadonlyMap<number, string> | undefined;
				try {
					texts =
						committed === undefined
							? undefined
							: regionTexts(
									parseMergeSegments(file.merged, file.markerSize),
									committed,
								);
				} catch {
					texts = undefined;
				}
				previous.set(file.path, {
					regions: [...(texts ?? [])].map(([id, resolution]) => ({
						id,
						resolution,
					})),
					checkFailures: repair.failures,
				});
			}
		const day = startOfDay();
		// Regions resolved before, in resolutions whose checks then passed.
		const recorded = new Map<string, string>();
		for (const checked of await journal.recent(
			repository,
			"ci.agent.ResolutionChecked",
			new Date(Date.parse(now()) - 90 * 86_400_000).toISOString(),
		))
			if (checked.checksState === "success")
				for (const region of checked.resolution?.regions ?? [])
					recorded.set(region.conflictSha256, region.resolution);
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
			// A repair corrects what was rejected; anything else may reuse
			// what passed before.
			previous: repair ? previous : undefined,
			recorded,
			structured: options.structured,
			onEngineFailure: (failure) => engineFailures.push(failure),
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
						parents: repair ? [repair.of.commitSha] : [ours, theirs],
						files: new Map(files.map((file) => [file.path, file.content])),
						message: [
							repair
								? `Repair the merge of ${input.theirsLabel} into ${input.oursLabel} after its checks failed`
								: `Merge ${input.theirsLabel} into ${input.oursLabel}`,
							"",
							`Conflicts in ${files.length} file(s) were resolved by hobo-ci-agent:`,
							...files.map((file) =>
								file.structured
									? `- ${file.path} (structured merge of the whole file)`
									: `- ${file.path} (${file.regions} region(s))`,
							),
							"",
							"This merge was written by an automated agent and has not been reviewed.",
							"The required checks on this commit are its verification.",
							"",
							`Hobo-Agent-Resolution: ${key}`,
							...(repair ? [`Hobo-Agent-Repairs: ${repair.of.key}`] : []),
							result.engineId === "recorded"
								? "Hobo-Agent-Engine: recorded resolutions"
								: result.engineId === "structured"
									? `Hobo-Agent-Engine: structured merge (${result.model})`
									: `Hobo-Agent-Engine: ${result.engineId} (${result.model})`,
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
				structured: file.structured,
			})),
			engineId: result.engineId,
			model: result.model,
			usage: {
				inputTokens: BigInt(result.usage.inputTokens),
				outputTokens: BigInt(result.usage.outputTokens),
			},
			commitSha,
			regions: files.flatMap((file) => file.recorded),
			repairs: repair?.of.key ?? "",
			attempt: repair ? repair.of.attempt + 1 : 0,
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
				applyWithheld: false,
				ejected: [],
				failures: 0,
				engineFailures: [],
			};
			engineFailures = report.engineFailures;
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
			// A trial merge that failed is not evidence of a clean one.
			const baseUnknown = new Set<number>();
			for (const entry of entries) {
				const merge = await attempt(() => trial(entry.headSha, baseSha));
				if (!merge) baseUnknown.add(entry.number);
				else if (!merge.clean)
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
			// A pull request the agent enqueued at this commit that is waiting
			// again was ejected by the merge queue: its checks failed in a merge
			// group. It is batched alone from now on, so whatever failed it cannot
			// fail others with it, and it is not enqueued again at this commit.
			const isolated = new Set<number>();
			const enqueuedBefore = Date.parse(now()) - 120_000;
			const weekAgo = new Date(
				Date.parse(now()) - 7 * 86_400_000,
			).toISOString();
			const enqueuedEvents = await journal.recent(
				repository,
				"ci.agent.EntryEnqueued",
				weekAgo,
			);
			for (const entry of entries) {
				if (entry.started) continue;
				if (
					!enqueuedEvents.some(
						(event) =>
							event.numbers[0] === entry.number &&
							event.headSha === entry.headSha &&
							Date.parse(event.at) <= enqueuedBefore,
					)
				)
					continue;
				isolated.add(entry.number);
				if (
					await journal.has(ejectedKey(repository, entry.number, entry.headSha))
				)
					continue;
				await record(repository, "ci.agent.EntryEjected", {
					numbers: [entry.number],
					headSha: entry.headSha,
				});
				report.ejected.push(entry.number);
				if (config.mode !== "observe")
					await attempt(() =>
						publisher.comment(
							entry.number,
							`**hobo-ci-agent** added this pull request to the merge queue at ${entry.headSha}, and the queue removed it. The agent will not add this commit again; push a new commit, or add it to the queue by hand.`,
						),
					);
			}
			const plan = planQueue({
				snapshot,
				verdicts,
				baseConflicts,
				policy: policy.queue,
				isolated,
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

			// In apply mode, text no person has read can enter the merge queue. The
			// only thing standing between it and the base branch is then the
			// repository's required checks, so apply acts only when the host
			// confirms the base branch has them. Otherwise this pass suggests.
			let mode = config.mode;
			if (
				mode === "apply" &&
				(await attempt(() => options.queue.baseRequiresChecks())) !== true
			) {
				mode = "suggest";
				report.applyWithheld = true;
				const last = await journal.latest(repository, "ci.agent.ApplyWithheld");
				if (!last || last.at < startOfDay())
					await record(repository, "ci.agent.ApplyWithheld", {});
			}

			// A pull request that no longer merges onto its base branch. A stacked
			// one waits: its parent's resolution is part of its own history.
			for (const entry of ordered) {
				if (!baseConflicts.has(entry.number) || entry.baseRef !== baseRef)
					continue;
				const settled = await settleFresh({
					repository,
					number: entry.number,
					ours: entry.headSha,
					theirs: baseSha,
					oursLabel: `pull request #${entry.number}`,
					theirsLabel: baseRef,
				});
				const resolution = settled?.resolution;
				// A resolution settled on an earlier pass is published now if its
				// push never succeeded (or the mode then was observe).
				if (
					resolution?.outcome !== "resolved" ||
					mode === "observe" ||
					(await journal.has(publishedKey(resolution.key)))
				)
					continue;
				const direct = mode === "apply" && !entry.fork;
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

			// Read the checks on resolutions published in the last day. A failed
			// one is repaired on top of its own commit, at most maxRepairs times;
			// past that, or when it cannot be repaired, a person is told.
			if (mode !== "observe") {
				const since = new Date(Date.parse(now()) - 86_400_000).toISOString();
				for (const event of await journal.recent(
					repository,
					"ci.agent.ResolutionPublished",
					since,
				)) {
					const published = event.resolution;
					if (!published || (await journal.has(checkedKey(published.key))))
						continue;
					const checks = await attempt(() =>
						options.queue.commitChecks(published.commitSha),
					);
					if (
						!checks ||
						checks.state === "pending" ||
						checks.state === "none" ||
						checks.state === "infrastructure"
					)
						continue;
					const concluded = (state: "success" | "failure") =>
						record(repository, "ci.agent.ResolutionChecked", {
							resolution: published,
							checksState: state,
						});
					if (checks.state === "success") {
						await concluded("success");
						continue;
					}
					const entry = byNumber.get(published.number);
					const direct = !published.publishedRef.startsWith(
						"refs/heads/hobo-agent/",
					);
					// A pull request that left, or whose branch moved on, is its
					// author's again.
					if (
						!entry ||
						(direct &&
							(mode !== "apply" || entry.headSha !== published.commitSha))
					) {
						await concluded("failure");
						continue;
					}
					const canRepair = published.attempt < policy.resolution.maxRepairs;
					const repaired = canRepair
						? await settleFresh({
								repository,
								number: published.number,
								ours: published.oursSha,
								theirs: published.theirsSha,
								oursLabel: `pull request #${published.number}`,
								theirsLabel: baseRef,
								repair: { of: published, failures: checks.failures },
							})
						: undefined;
					// Deferred by the budget, the per-pass limit or an error: next pass.
					if (canRepair && repaired === undefined) continue;
					const resolution = repaired?.resolution;
					if (resolution?.outcome === "resolved") {
						const pushed = await attempt(() =>
							publish(
								entry,
								resolution,
								published.publishedRef,
								"ci.agent.ResolutionPublished",
								[
									`**hobo-ci-agent**: the required checks failed on its merge commit ${published.commitSha}.`,
									"",
									`It pushed a corrected merge commit, ${resolution.commitSha}, to ${quoted(published.publishedRef.slice(11))}, written by a model (${quoted(resolution.model)}) from what the checks reported. It has not been reviewed.`,
								].join("\n"),
								[entry.number],
							),
						);
						// An unpublished repair is pushed again next pass.
						if (pushed) await concluded("failure");
						continue;
					}
					// Out of attempts, or the repair abstained: a person resolves it.
					await concluded("failure");
					await attempt(() =>
						publisher.comment(
							entry.number,
							`**hobo-ci-agent**: the required checks failed on its merge commit ${published.commitSha}, and it will not try again. Resolve the conflict by hand${direct ? ", or revert that commit" : ""}.`,
						),
					);
				}
			}

			// Feed the host's merge queue in planned order.
			if (mode === "apply") {
				// A pull request whose head is one of the agent's own merge commits
				// waits until the required checks have passed on that commit.
				const unproven = new Set<string>();
				for (const event of await journal.recent(
					repository,
					"ci.agent.ResolutionPublished",
					weekAgo,
				)) {
					const commit = event.resolution?.commitSha;
					const key = event.resolution?.key ?? "";
					if (!commit) continue;
					const checked = await journal.latestChecked(key);
					if (checked?.checksState !== "success") unproven.add(commit);
				}
				// Two pull requests that conflict cannot share a merge group: wait
				// until the one ahead merges, then resolve against the base branch.
				const verdictOf = createVerdicts(verdicts);
				const queued = new Set(
					entries.filter((entry) => entry.started).map((entry) => entry.number),
				);
				for (const entry of ordered) {
					if (report.enqueued.length >= policy.queue.maxBatchSize) break;
					const key = `${entry.number}:${entry.headSha}`;
					if (
						entry.started ||
						entry.baseRef !== baseRef ||
						baseConflicts.has(entry.number) ||
						baseUnknown.has(entry.number) ||
						isolated.has(entry.number) ||
						unproven.has(entry.headSha) ||
						[...queued].some((number) => {
							const ahead = byNumber.get(number);
							return (
								ahead !== undefined &&
								verdictOf(ahead, entry).verdict !== "clean"
							);
						}) ||
						entry.dependsOn.some((parent) => !queued.has(parent)) ||
						Date.parse(now()) - (enqueueAskedAt.get(key) ?? 0) < 600_000 ||
						// Enqueued once at this commit already. If the queue ejected it
						// (its checks failed), a person or a new commit re-enqueues it.
						(await journal.has(
							enqueuedKey(repository, entry.number, entry.headSha),
						))
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
							headSha: entry.headSha,
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
