import { createHash } from "node:crypto";
import { z } from "zod";
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
import type { StructuredMerger } from "./structured-merge.js";
import { verifyResolvedFile } from "./verify.js";

export type ConflictFile = Readonly<{
	path: string;
	kind: "content" | "unsupported";
	merged: string;
	markerSize: number;
	bytes: number;
	ours?: string;
	theirs?: string;
	base?: string;
}>;

export type EngineRegion = Readonly<{
	id: number;
	ours: string;
	base: string;
	theirs: string;
	before: string;
	after: string;
}>;

export type PreviousAttempt = Readonly<{
	regions: readonly Readonly<{ id: number; resolution: string }>[];
	checkFailures: string;
}>;

export type EngineRequest = Readonly<{
	path: string;
	oursLabel: string;
	theirsLabel: string;
	regions: readonly EngineRegion[];
	previous?: PreviousAttempt | undefined;
	maxOutputTokens: number;
	signal: AbortSignal;
}>;

export type EngineAnswer = Readonly<{
	regions: readonly Readonly<{
		id: number;
		resolution: string;
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
	| "repeated-context"
	| "unparseable-resolution"
	| "duplicate-declaration"
	| "engine-unavailable";

/**
 * Why an engine gave no usable answer, for the operator: the engine, a fixed
 * reason, and the HTTP status when there was one (402 for an unpaid account,
 * 401 for a bad key). Never the error's text, which can carry the request.
 */
export type EngineFailure = Readonly<{
	engineId: string;
	reason: "http" | "timeout" | "malformed-answer" | "error";
	status: number;
}>;

const HttpError = z.object({ statusCode: z.number().int().min(100).max(599) });

const TIMEOUT_ERRORS = new Set(["TimeoutError", "AbortError"]);

export type ResolvedContent = Readonly<{
	path: string;
	content: string;
	regions: number;
	confidence: number;
	contentSha256: string;
	/** Each region's text, by the conflict it resolved: what a later merge can reuse. */
	recorded: readonly RecordedRegion[];
	structured: boolean;
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
	pending: readonly EngineRegion[];
	recorded: ReadonlyMap<string, string> | undefined;
	structured: boolean;
}>;

/** A conservative token estimate: three characters a token, not the usual four. */
const estimateTokens = (characters: number) => Math.ceil(characters / 3);

export async function resolveConflicts(input: {
	files: readonly ConflictFile[];
	policy: ResolutionPolicy;
	budget: AgentBudget;
	engines: readonly ResolutionEngine[];
	remainingTokens: number;
	oursLabel: string;
	theirsLabel: string;
	previous?: ReadonlyMap<string, PreviousAttempt> | undefined;
	/**
	 * Conflict regions resolved before, in resolutions whose checks passed,
	 * by `conflictKey`. A region found here is not sent to an engine, as git
	 * rerere reuses a recorded resolution. Ignored for a repair.
	 */
	recorded?: ReadonlyMap<string, string> | undefined;
	structured?: StructuredMerger | undefined;
	onEngineFailure?: ((failure: EngineFailure) => void) | undefined;
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
	for (const original of files) {
		const file = await structuredMerge(original, input, budget.timeoutSeconds);
		const structured = file !== original;
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
		const recorded = input.previous ? undefined : input.recorded;
		const pending = regions.filter(
			(region) => !recorded?.has(conflictKey(region)),
		);
		prepared.push({ file, segments, regions, pending, recorded, structured });
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
	const calls = asking.length;
	const reservation = inputEstimate + budget.maxOutputTokens * calls;
	if (reservation > input.remainingTokens) return refuse("daily-budget");

	const usage = { inputTokens: 0, outputTokens: 0 };
	let last = { engineId: "", model: "" };
	const settled =
		input.structured && prepared.some((entry) => entry.structured)
			? { ...RECORDED_ENGINE, id: "structured", model: input.structured.id }
			: RECORDED_ENGINE;
	for (const engine of asking.length > 0 ? input.engines : [settled]) {
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
				resolved.push(
					content(
						entry.file.path,
						entry.file.merged,
						0,
						1,
						[],
						entry.structured,
					),
				);
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
				} catch (error) {
					const http = HttpError.safeParse(error);
					input.onEngineFailure?.(
						http.success
							? {
									engineId: engine.id,
									reason: "http",
									status: http.data.statusCode,
								}
							: {
									engineId: engine.id,
									reason:
										error instanceof Error && TIMEOUT_ERRORS.has(error.name)
											? "timeout"
											: "error",
									status: 0,
								},
					);
					unavailable = true;
					break;
				}
				usage.inputTokens += answer.usage.inputTokens;
				usage.outputTokens += answer.usage.outputTokens;
				const ids = new Set(answer.regions.map((region) => region.id));
				if (
					ids.size !== answer.regions.length ||
					ids.size !== entry.pending.length ||
					entry.pending.some((region) => !ids.has(region.id))
				) {
					input.onEngineFailure?.({
						engineId: engine.id,
						reason: "malformed-answer",
						status: 0,
					});
					unavailable = true;
					break;
				}
				for (const region of answer.regions) answers.set(region.id, region);
			}
			const texts = new Map<number, string>();
			const recorded: RecordedRegion[] = [];
			let confidence = 1;
			for (const [index, segment] of entry.segments.entries()) {
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
				const fitted = fitRegionResolution(
					segment,
					region.resolution,
					regionContext(entry.segments, index, 3),
				);
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
					false,
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
	structured: boolean,
): ResolvedContent {
	return {
		path,
		content: text,
		regions,
		confidence,
		recorded,
		structured,
		contentSha256: createHash("sha256").update(text).digest("hex"),
	};
}

async function structuredMerge(
	file: ConflictFile,
	input: Readonly<{
		structured?: StructuredMerger | undefined;
		previous?: ReadonlyMap<string, PreviousAttempt> | undefined;
	}>,
	timeoutSeconds: number,
): Promise<ConflictFile> {
	const { base, ours, theirs } = file;
	if (
		!input.structured ||
		input.previous ||
		file.kind !== "content" ||
		base === undefined ||
		ours === undefined ||
		theirs === undefined
	)
		return file;
	const merged = await input.structured.merge({
		path: file.path,
		base,
		ours,
		theirs,
		signal: AbortSignal.timeout(timeoutSeconds * 1000),
	});
	if (
		merged === undefined ||
		merged.length > ours.length + theirs.length + 4096 ||
		verifyResolvedFile({ path: file.path, ours, theirs, resolved: merged })
	)
		return file;
	return { ...file, merged };
}
