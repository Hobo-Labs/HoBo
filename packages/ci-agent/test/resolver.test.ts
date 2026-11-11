import { describe, expect, it } from "vitest";
import {
	type ConflictFile,
	conflictKey,
	resolveConflicts,
} from "../src/resolver.js";
import { type PolicyOverrides, testPolicies } from "./fixtures/config.js";
import { scriptedEngine, takeBoth } from "./fixtures/engine.js";

const region = (ours: string, theirs: string) =>
	`<<<<<<< ours\n${ours}||||||| base\nold\n=======\n${theirs}>>>>>>> theirs\n`;
const file = (
	path: string,
	merged: string,
	extra: Partial<ConflictFile> = {},
) =>
	({
		path,
		kind: "content",
		merged,
		markerSize: 7,
		bytes: merged.length,
		...extra,
	}) satisfies ConflictFile;
const conflicted = file(
	"src/a.ts",
	`head\n${region("ours 1\n", "theirs 1\n")}middle\n${region("ours 2\n", "theirs 2\n")}tail\n`,
);
const run = (
	files: ConflictFile[],
	engines = [takeBoth()],
	overrides: PolicyOverrides = {},
	remainingTokens = 1_000_000,
) => {
	const { resolution, budget } = testPolicies(overrides);
	return resolveConflicts({
		files,
		policy: resolution,
		budget,
		engines,
		remainingTokens,
		oursLabel: "pull request #1",
		theirsLabel: "main",
	});
};

describe("conflict resolver", () => {
	it("replaces only the conflict regions and reports the engine and usage", async () => {
		const engine = takeBoth(0.9);
		const result = await run([conflicted], [engine]);
		expect(result).toMatchObject({
			outcome: "resolved",
			engineId: "scripted",
			model: "scripted-model",
			usage: { inputTokens: 100, outputTokens: 20 },
			files: [
				{
					path: "src/a.ts",
					regions: 2,
					confidence: 0.9,
					content: "head\nours 1\ntheirs 1\nmiddle\nours 2\ntheirs 2\ntail\n",
				},
			],
		});
		// The engine saw the regions and their neighbours, and nothing else.
		expect(engine.requests).toHaveLength(1);
		expect(engine.requests[0]?.regions[0]).toEqual({
			id: 0,
			ours: "ours 1\n",
			base: "old\n",
			theirs: "theirs 1\n",
			before: "head\n",
			after: "middle\n",
		});
	});

	it.each([
		["protected-path", [file("pnpm-lock.yaml", conflicted.merged)], {}],
		[
			"protected-path",
			[file(".github/workflows/ci.yml", conflicted.merged)],
			{},
		],
		[
			"protected-path",
			[file("db/migrations/1.sql", conflicted.merged)],
			{ resolution: { protectedPaths: ["**/migrations/**"] } },
		],
		[
			"unsupported-conflict",
			[file("logo.png", "", { kind: "unsupported" })],
			{},
		],
		[
			"too-many-files",
			[conflicted, file("src/b.ts", conflicted.merged)],
			{ resolution: { maxConflictedFiles: 1 } },
		],
		[
			"too-many-regions",
			[conflicted],
			{ resolution: { maxConflictRegions: 1 } },
		],
		[
			"file-too-large",
			[file("src/a.ts", conflicted.merged, { bytes: 9_999 })],
			{ resolution: { maxFileBytes: 1000 } },
		],
		[
			"unparseable-conflict",
			[file("src/a.ts", "<<<<<<< ours\nnever closed\n")],
			{},
		],
		["input-budget", [conflicted], { budget: { maxInputTokens: 10 } }],
	] as const)("abstains with %s before asking any engine", async (reason, files, overrides) => {
		const engine = takeBoth();
		const result = await run([...files], [engine], overrides);
		expect(result).toMatchObject({ outcome: "abstained", reason });
		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(engine.requests).toHaveLength(0);
	});

	it("abstains when today's budget cannot cover the attempt", async () => {
		const engine = takeBoth();
		const result = await run([conflicted], [engine], {}, 500);
		expect(result).toMatchObject({
			outcome: "abstained",
			reason: "daily-budget",
		});
		expect(engine.requests).toHaveLength(0);
	});

	it("abstains on low confidence and does not ask a second engine for a better number", async () => {
		const unsure = takeBoth(0.4);
		const second = takeBoth(0.99);
		const result = await run([conflicted], [unsure, second]);
		expect(result).toMatchObject({
			outcome: "abstained",
			reason: "low-confidence",
			engineId: "scripted",
			usage: { inputTokens: 100, outputTokens: 20 },
		});
		expect(second.requests).toHaveLength(0);
	});

	it("abstains when a replacement carries conflict markers", async () => {
		const result = await run(
			[conflicted],
			[
				scriptedEngine((request) =>
					request.regions.map((entry) => ({
						id: entry.id,
						resolution: `<<<<<<< ours\n${entry.ours}`,
						confidence: 1,
					})),
				),
			],
		);
		expect(result).toMatchObject({
			outcome: "abstained",
			reason: "conflict-marker",
		});
	});

	it("falls through to the next engine when one throws or answers the wrong regions", async () => {
		const broken = scriptedEngine(() => {
			throw new Error("503 from provider");
		});
		const partial = scriptedEngine((request) => [
			{ id: request.regions[0]?.id ?? 0, resolution: "x\n", confidence: 1 },
		]);
		const invented = scriptedEngine((request) => [
			...request.regions.map((entry) => ({
				id: entry.id,
				resolution: "x\n",
				confidence: 1,
			})),
			{ id: 99, resolution: "extra\n", confidence: 1 },
		]);
		const working = takeBoth();
		const result = await run(
			[conflicted],
			[broken, partial, invented, working],
		);
		expect(result.outcome).toBe("resolved");
		expect(working.requests).toHaveLength(1);
		// Tokens the failed engines did report are still counted.
		expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 60 });
	});

	it("reserves output for every file, and does not let a fallback engine overspend", async () => {
		const second = file("src/b.ts", conflicted.merged);
		// One file reserves about 1,760 tokens (its prompt plus 1,000 output); two do not fit.
		const { resolution, budget } = testPolicies({
			budget: { maxOutputTokens: 1000 },
		});
		const one = await resolveConflicts({
			files: [conflicted],
			policy: resolution,
			budget,
			engines: [takeBoth()],
			remainingTokens: 1800,
			oursLabel: "a",
			theirsLabel: "b",
		});
		expect(one.outcome).toBe("resolved");
		const two = await resolveConflicts({
			files: [conflicted, second],
			policy: resolution,
			budget,
			engines: [takeBoth()],
			remainingTokens: 1800,
			oursLabel: "a",
			theirsLabel: "b",
		});
		expect(two).toMatchObject({ outcome: "abstained", reason: "daily-budget" });

		// The first engine spends 120 tokens and answers the wrong regions; 120 plus
		// another full reservation exceeds 1,800, so the fallback is skipped.
		const wrong = scriptedEngine(() => [
			{ id: 99, resolution: "x\n", confidence: 1 },
		]);
		const fallback = takeBoth();
		const spent = await resolveConflicts({
			files: [conflicted],
			policy: resolution,
			budget,
			engines: [wrong, fallback],
			remainingTokens: 1800,
			oursLabel: "a",
			theirsLabel: "b",
		});
		expect(spent).toMatchObject({
			outcome: "failed",
			reason: "engine-unavailable",
			usage: { inputTokens: 100, outputTokens: 20 },
		});
		expect(fallback.requests).toHaveLength(0);
	});

	it.each([
		["unparseable-resolution", "export const a = (1;\n"],
		["duplicate-declaration", "export const a = 1;\nexport const a = 2;\n"],
	])("abstains with %s when the resolved file fails its checks", async (reason, text) => {
		const source = file(
			"src/a.ts",
			region("export const a = 1;\n", "export const a = 2;\n"),
			{ ours: "export const a = 1;\n", theirs: "export const a = 2;\n" },
		);
		const engine = scriptedEngine((request) =>
			request.regions.map((entry) => ({
				id: entry.id,
				resolution: text,
				confidence: 1,
			})),
		);
		expect(await run([source], [engine])).toMatchObject({
			outcome: "abstained",
			reason,
		});
	});

	it("reuses recorded resolutions and asks an engine only about the rest", async () => {
		const { resolution, budget } = testPolicies();
		const first = conflictKey({
			ours: "ours 1\n",
			base: "old\n",
			theirs: "theirs 1\n",
		});
		const both = conflictKey({
			ours: "ours 2\n",
			base: "old\n",
			theirs: "theirs 2\n",
		});
		const call = (
			recorded: Map<string, string>,
			engines = [takeBoth()],
			previous?: Map<
				string,
				{ regions: { id: number; resolution: string }[]; checkFailures: string }
			>,
		) =>
			resolveConflicts({
				files: [conflicted],
				policy: resolution,
				budget,
				engines,
				remainingTokens: 1_000_000,
				oursLabel: "a",
				theirsLabel: "b",
				recorded,
				previous,
			});
		// Both regions recorded: no engine is asked, nothing is spent.
		const unused = takeBoth();
		const all = await call(
			new Map([
				[first, "recorded 1\n"],
				[both, "recorded 2\n"],
			]),
			[unused],
		);
		expect(all).toMatchObject({
			outcome: "resolved",
			engineId: "recorded",
			usage: { inputTokens: 0, outputTokens: 0 },
			files: [{ content: "head\nrecorded 1\nmiddle\nrecorded 2\ntail\n" }],
		});
		expect(unused.requests).toHaveLength(0);
		// One recorded: the engine sees only the other.
		const partial = takeBoth();
		const some = await call(new Map([[first, "recorded 1\n"]]), [partial]);
		expect(partial.requests[0]?.regions.map((region) => region.id)).toEqual([
			1,
		]);
		expect(some).toMatchObject({
			outcome: "resolved",
			files: [
				{
					content: "head\nrecorded 1\nmiddle\nours 2\ntheirs 2\ntail\n",
					recorded: [
						{ conflictSha256: first, resolution: "recorded 1\n" },
						{ conflictSha256: both, resolution: "ours 2\ntheirs 2\n" },
					],
				},
			],
		});
		// A repair corrects what was rejected, so it asks about every region.
		const repairing = takeBoth();
		await call(
			new Map([[first, "recorded 1\n"]]),
			[repairing],
			new Map([["src/a.ts", { regions: [], checkFailures: "x" }]]),
		);
		expect(repairing.requests[0]?.regions).toHaveLength(2);
	});

	it("fails when no engine answers", async () => {
		const broken = scriptedEngine(() => {
			throw new Error("timeout");
		});
		expect(await run([conflicted], [broken])).toMatchObject({
			outcome: "failed",
			reason: "engine-unavailable",
		});
	});

	it("passes through a flagged path whose text merged without regions", async () => {
		const engine = takeBoth();
		const result = await run([file("src/a.ts", "already merged\n")], [engine]);
		expect(result).toMatchObject({
			outcome: "resolved",
			files: [{ regions: 0, content: "already merged\n" }],
		});
		expect(engine.requests).toHaveLength(0);
	});
});
