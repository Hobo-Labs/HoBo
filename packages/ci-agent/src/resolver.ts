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
}>;

export type EngineRegion = Readonly<{
	id: number;
	ours: string;
	base: string;
	theirs: string;
	before: string;
	after: string;
}>;

export type EngineRequest = Readonly<{
	path: string;
	oursLabel: string;
	theirsLabel: string;
	regions: readonly EngineRegion[];
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
	| "engine-unavailable";

export type ResolvedContent = Readonly<{
	path: string;
	content: string;
	regions: number;
	confidence: number;
	contentSha256: string;
}>;

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
		prepared.push({ file, segments, regions });
	}
	const regionCount = prepared.reduce(
		(total, entry) => total + entry.regions.length,
		0,
	);
	if (regionCount > policy.maxConflictRegions)
		return refuse("too-many-regions");
	const inputEstimate = estimateTokens(
		prepared.reduce(
			(total, entry) => total + JSON.stringify(entry.regions).length + 2048,
			0,
		),
	);
	if (inputEstimate > budget.maxInputTokens) return refuse("input-budget");
	if (inputEstimate + budget.maxOutputTokens > input.remainingTokens)
		return refuse("daily-budget");

	const usage = { inputTokens: 0, outputTokens: 0 };
	let last = { engineId: "", model: "" };
	for (const engine of input.engines) {
		last = { engineId: engine.id, model: engine.model };
		const resolved: ResolvedContent[] = [];
		let unavailable = false;
		for (const entry of prepared) {
			if (entry.regions.length === 0) {
				// The trial merge flagged the path, but its text merged cleanly.
				resolved.push(content(entry.file.path, entry.file.merged, 0, 1));
				continue;
			}
			let answer: EngineAnswer;
			try {
				answer = await engine.resolve({
					path: entry.file.path,
					oursLabel: input.oursLabel,
					theirsLabel: input.theirsLabel,
					regions: entry.regions,
					maxOutputTokens: budget.maxOutputTokens,
					signal: AbortSignal.timeout(budget.timeoutSeconds * 1000),
				});
			} catch {
				unavailable = true;
				break;
			}
			usage.inputTokens += answer.usage.inputTokens;
			usage.outputTokens += answer.usage.outputTokens;
			const answers = new Map(
				answer.regions.map((region) => [region.id, region]),
			);
			// An answer for the wrong set of regions is a broken engine, not a judgement.
			if (
				answers.size !== answer.regions.length ||
				answers.size !== entry.regions.length ||
				entry.regions.some((region) => !answers.has(region.id))
			) {
				unavailable = true;
				break;
			}
			const texts = new Map<number, string>();
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
				confidence = Math.min(confidence, region.confidence);
			}
			resolved.push(
				content(
					entry.file.path,
					composeMerged(entry.segments, texts),
					entry.regions.length,
					confidence,
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
): ResolvedContent {
	return {
		path,
		content: text,
		regions,
		confidence,
		contentSha256: createHash("sha256").update(text).digest("hex"),
	};
}
