import { describe, expect, it } from "vitest";
import { type ConflictFile, resolveConflicts } from "../src/resolver.js";
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
