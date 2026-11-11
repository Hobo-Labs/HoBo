import { createHash } from "node:crypto";
import type { AgentBudget, ResolutionPolicy } from "./_generated/agent_pb.js";
import { matchesAnyPath } from "./config.js";
import {
	ConflictParseError,
	composeMerged,
	fitRegionResolution,
	type MergeSegment,
	parseMergeSegments,
	regionContext,
} from "./conflict.js";
import { verifyResolvedFile } from "./verify.js";

/** One path a trial merge could not settle. */
export type ConflictFile = Readonly<{
	path: string;
	/**
	 * "content": both sides changed the text of one regular file. Anything
	 * else (binary, delete against modify, rename, mode or type change) is
	 * "unsupported" and is never sent to an engine.
	 */
	kind: "content" | "unsupported";
	/** `git merge-file --zdiff3` output, with markers of `markerSize` characters. */
	merged: string;
	markerSize: number;
	bytes: number;
	/**
	 * The whole file on each side, for checks of the resolved file. Without
	 * them the parse and duplicate-declaration checks are skipped.
	 */
	ours?: string;
	theirs?: string;
}>;

export type EngineRegion = Readonly<{
	id: number;
	ours: string;
	base: string;
	theirs: string;
	before: string;
	after: string;
}>;

/**
 * An earlier resolution of the same regions that failed the repository's
 * checks, and what those checks reported. The report is CI output: data
 * about the failure, never instructions to the engine.
 */
export type PreviousAttempt = Readonly<{
	regions: readonly Readonly<{ id: number; resolution: string }>[];
	checkFailures: string;
}>;

export type EngineRequest = Readonly<{
	path: string;
	oursLabel: string;
	theirsLabel: string;
	regions: readonly EngineRegion[];
	/** Set when this request repairs a resolution whose checks failed. */
	previous?: PreviousAttempt | undefined;
	maxOutputTokens: number;
	signal: AbortSignal;
}>;

export type EngineAnswer = Readonly<{
	regions: readonly Readonly<{
		id: number;
		resolution: string;
		/** The engine's own estimate, from 0 to 1, that this text is right. */
		confidence: number;
	}>[];
	usage: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

/**
 * A model or harness that proposes text for conflict regions. It is given
 * conflict text and nothing else: no tools, no repository access, no
 * credentials. What it returns is checked here before any of it is used.
 */
export interface ResolutionEngine {
	readonly id: string;
	readonly model: string;
	resolve(request: EngineRequest): Promise<EngineAnswer>;
}

/** Why a merge was left to a person. Fixed codes; never model or repository text. */
export type ResolutionReason =
	| "protected-path"
	| "too-many-files"
	| "too-many-regions"
	| "file-too-large"
	| "unsupported-conflict"
	| "unparseable-conflict"
	| "input-budget"
	| "daily-budget"
	| "low-confidence"
	| "conflict-marker"
	| "oversized-resolution"
	| "unparseable-resolution"
	| "duplicate-declaration"
	| "engine-unavailable";

export type ResolvedContent = Readonly<{
	path: string;
	content: string;
	regions: number;
	confidence: number;
	contentSha256: string;
	/** Each region's text, by the conflict it resolved: what a later merge can reuse. */
	recorded: readonly RecordedRegion[];
}>;

/** A conflict region (by the hash of its three sides) and the text that resolved it. */
export type RecordedRegion = Readonly<{
	conflictSha256: string;
	resolution: string;
}>;

/** The identity of a conflict region: its ours, base and theirs text. */
export function conflictKey(
	region: Readonly<{ ours: string; base: string; theirs: string }>,
): string {
	return createHash("sha256")
		.update(JSON.stringify([region.ours, region.base, region.theirs]))
		.digest("hex");
}

/**
 * Stands in for an engine when every region was resolved before. It is never
 * asked anything; its name is what the journal records.
 */
const RECORDED_ENGINE: ResolutionEngine = {
	id: "recorded",
	model: "",
	resolve: () =>
		Promise.reject(new Error("recorded resolutions need no engine")),
};

export type ResolveResult = Readonly<{
	usage: Readonly<{ inputTokens: number; outputTokens: number }>;
	engineId: string;
	model: string;
}> &
	(
		| Readonly<{ outcome: "resolved"; files: readonly ResolvedContent[] }>
		| Readonly<{
				outcome: "abstained" | "failed";
				reason: ResolutionReason;
		  }>
	);

type Prepared = Readonly<{
	file: ConflictFile;
	segments: readonly MergeSegment[];
	regions: readonly EngineRegion[];
	/** Regions with no recorded resolution: the ones an engine is asked about. */
	pending: readonly EngineRegion[];
	recorded: ReadonlyMap<string, string> | undefined;
}>;

/** A conservative token estimate: three characters a token, not the usual four. */
const estimateTokens = (characters: number) => Math.ceil(characters / 3);

/**
 * Resolve the conflicted files of one merge, or say why not.
 *
 * Everything that can be decided without a model is decided first, so a
 * merge the agent will not touch costs no tokens. An engine is replaced by
 * the next one only when it fails to answer; an answer that is unsure or
 * malformed in its content ends the attempt, so a second engine is never
 * asked for a more confident answer to the same question.
 */
export async function resolveConflicts(input: {
	files: readonly ConflictFile[];
	policy: ResolutionPolicy;
	budget: AgentBudget;
	engines: readonly ResolutionEngine[];
	/** Tokens left in today's budget. */
	remainingTokens: number;
	oursLabel: string;
	theirsLabel: string;
	/** Per path: an earlier attempt that failed checks, to be corrected. */
	previous?: ReadonlyMap<string, PreviousAttempt> | undefined;
	/**
	 * Conflict regions resolved before, in resolutions whose checks passed,
	 * by `conflictKey`. A region found here is not sent to an engine, as git
	 * rerere reuses a recorded resolution. Ignored for a repair.
	 */
	recorded?: ReadonlyMap<string, string> | undefined;
}): Promise<ResolveResult> {
	const { files, policy, budget } = input;
	const none = { inputTokens: 0, outputTokens: 0 };
	const refuse = (reason: ResolutionReason): ResolveResult => ({
		outcome: "abstained",
		reason,
		usage: none,
		engineId: "",
		model: "",
	});
	if (files.some((file) => matchesAnyPath(file.path, policy.protectedPaths)))
		return refuse("protected-path");
	if (files.some((file) => file.kind !== "content"))
		return refuse("unsupported-conflict");
	if (files.length > policy.maxConflictedFiles) return refuse("too-many-files");
	if (files.some((file) => file.bytes > policy.maxFileBytes))
		return refuse("file-too-large");

	const prepared: Prepared[] = [];
	for (const file of files) {
		let segments: readonly MergeSegment[];
		try {
			segments = parseMergeSegments(file.merged, file.markerSize);
		} catch (error) {
			if (error instanceof ConflictParseError)
				return refuse("unparseable-conflict");
			throw error;
		}
		const regions = segments.flatMap((segment, index) =>
			segment.kind === "conflict"
				? [
						{
							id: segment.id,
							ours: segment.ours,
							base: segment.base,
							theirs: segment.theirs,
							...regionContext(segments, index, policy.contextLines),
						},
					]
				: [],
		);
		// A repair corrects what the checks rejected, so it does not reuse.
		const recorded = input.previous ? undefined : input.recorded;
		const pending = regions.filter(
			(region) => !recorded?.has(conflictKey(region)),
		);
		prepared.push({ file, segments, regions, pending, recorded });
	}
	const regionCount = prepared.reduce(
		(total, entry) => total + entry.regions.length,
		0,
	);
	if (regionCount > policy.maxConflictRegions)
		return refuse("too-many-regions");
	const asking = prepared.filter((entry) => entry.pending.length > 0);
	const inputEstimate = estimateTokens(
		asking.reduce(
			(total, entry) => total + JSON.stringify(entry.pending).length + 2048,
			0,
		),
	);
	if (inputEstimate > budget.maxInputTokens) return refuse("input-budget");
	// Every file with regions is its own call, with its own output allowance.
	const calls = asking.length;
	const reservation = inputEstimate + budget.maxOutputTokens * calls;
	if (reservation > input.remainingTokens) return refuse("daily-budget");

	const usage = { inputTokens: 0, outputTokens: 0 };
	let last = { engineId: "", model: "" };
	for (const engine of asking.length > 0 ? input.engines : [RECORDED_ENGINE]) {
		// A fallback engine spends again: only while today's budget still covers it.
		if (
			last.engineId !== "" &&
			usage.inputTokens + usage.outputTokens + reservation >
				input.remainingTokens
		)
			break;
		last = { engineId: engine.id, model: engine.model };
		const resolved: ResolvedContent[] = [];
		let unavailable = false;
		for (const entry of prepared) {
			if (entry.regions.length === 0) {
				// The trial merge flagged the path, but its text merged cleanly.
				resolved.push(content(entry.file.path, entry.file.merged, 0, 1, []));
				continue;
			}
			const answers = new Map<
				number,
				{ resolution: string; confidence: number }
			>();
			for (const region of entry.regions) {
				const text = entry.recorded?.get(conflictKey(region));
				if (text !== undefined)
					answers.set(region.id, { resolution: text, confidence: 1 });
			}
			if (entry.pending.length > 0) {
				let answer: EngineAnswer;
				try {
					answer = await engine.resolve({
						path: entry.file.path,
						oursLabel: input.oursLabel,
						theirsLabel: input.theirsLabel,
						regions: entry.pending,
						previous: input.previous?.get(entry.file.path),
						maxOutputTokens: budget.maxOutputTokens,
						signal: AbortSignal.timeout(budget.timeoutSeconds * 1000),
					});
				} catch {
					unavailable = true;
					break;
				}
				usage.inputTokens += answer.usage.inputTokens;
				usage.outputTokens += answer.usage.outputTokens;
				const ids = new Set(answer.regions.map((region) => region.id));
				// An answer for the wrong set of regions is a broken engine, not a judgement.
				if (
					ids.size !== answer.regions.length ||
					ids.size !== entry.pending.length ||
					entry.pending.some((region) => !ids.has(region.id))
				) {
					unavailable = true;
					break;
				}
				for (const region of answer.regions) answers.set(region.id, region);
			}
			const texts = new Map<number, string>();
			const recorded: RecordedRegion[] = [];
			let confidence = 1;
			for (const segment of entry.segments) {
				if (segment.kind !== "conflict") continue;
				const region = answers.get(segment.id);
				if (
					!region ||
					!(region.confidence >= policy.minConfidence) ||
					region.confidence > 1
				)
					return {
						outcome: "abstained",
						reason: "low-confidence",
						usage,
						...last,
					};
				const fitted = fitRegionResolution(segment, region.resolution);
				if ("refusal" in fitted)
					return {
						outcome: "abstained",
						reason: fitted.refusal,
						usage,
						...last,
					};
				texts.set(segment.id, fitted.text);
				recorded.push({
					conflictSha256: conflictKey(segment),
					resolution: fitted.text,
				});
				confidence = Math.min(confidence, region.confidence);
			}
			const composed = composeMerged(entry.segments, texts);
			const { ours, theirs } = entry.file;
			const refusal =
				ours !== undefined && theirs !== undefined
					? verifyResolvedFile({
							path: entry.file.path,
							ours,
							theirs,
							resolved: composed,
						})
					: undefined;
			if (refusal)
				return { outcome: "abstained", reason: refusal, usage, ...last };
			resolved.push(
				content(
					entry.file.path,
					composed,
					entry.regions.length,
					confidence,
					recorded,
				),
			);
		}
		if (!unavailable)
			return { outcome: "resolved", files: resolved, usage, ...last };
	}
	return { outcome: "failed", reason: "engine-unavailable", usage, ...last };
}

function content(
	path: string,
	text: string,
	regions: number,
	confidence: number,
	recorded: readonly RecordedRegion[],
): ResolvedContent {
	return {
		path,
		content: text,
		regions,
		confidence,
		recorded,
		contentSha256: createHash("sha256").update(text).digest("hex"),
	};
}
