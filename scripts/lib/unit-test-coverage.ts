import { spawnSync } from "node:child_process";
import { z } from "zod";

import { commandForPlatform, sanitizeNodeOptions } from "./env.ts";
import {
	DRAFT_VITEST_SHARDS,
	draftUnitTestFiles,
	legacyUnitTestFiles,
	ROOT_VITEST_SHARDS,
	rootUnitTaskNames,
	rootUnitTestFiles,
	selectDraftShard,
	selectShard,
	type TestShard,
} from "./unit-test-selection.ts";

const dryRunSchema = z.object({
	tasks: z.array(
		z.object({
			taskId: z.string(),
			inputs: z.record(z.string(), z.string()).optional(),
		}),
	),
});

type DryTask = z.infer<typeof dryRunSchema>["tasks"][number];
type ShardSelector = (files: string[], shard: TestShard) => string[];

function shardedFiles(
	files: string[],
	count: number,
	selector: ShardSelector = selectShard,
): string[] {
	return Array.from({ length: count }, (_, index) =>
		selector(files, { index, count }),
	).flat();
}

function shardInputProblems(
	files: string[],
	count: number,
	taskPrefix: string,
	tasks: DryTask[],
	selector: ShardSelector = selectShard,
): string[] {
	return Array.from({ length: count }, (_, index) => {
		const taskId = `//#${taskPrefix}:${index}`;
		const task = tasks.find((candidate) => candidate.taskId === taskId);
		if (task === undefined)
			return [`${taskId} is missing from the turbo graph`];
		return selector(files, { index, count })
			.filter((file) => task.inputs?.[file] === undefined)
			.map((file) => `${file} is missing from ${taskId} inputs`);
	}).flat();
}

export function unitTestCoverageProblems(): string[] {
	const invocation = commandForPlatform("pnpm", [
		"exec",
		"turbo",
		"run",
		...rootUnitTaskNames,
		"--dry=json",
	]);
	const result = spawnSync(invocation.command, invocation.args, {
		encoding: "utf8",
		shell: false,
		env: sanitizeNodeOptions(),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		return [`turbo dry run failed: ${result.stderr || result.error?.message}`];
	}
	const plan = dryRunSchema.parse(JSON.parse(result.stdout));
	const rootFiles = rootUnitTestFiles();
	const draftFiles = draftUnitTestFiles();
	const coveredFiles = [
		...shardedFiles(rootFiles, ROOT_VITEST_SHARDS),
		...shardedFiles(draftFiles, DRAFT_VITEST_SHARDS, selectDraftShard),
	];
	const legacyFiles = legacyUnitTestFiles();
	const coveredSet = new Set(coveredFiles);
	const legacySet = new Set(legacyFiles);
	return [
		...legacyFiles
			.filter((file) => !coveredSet.has(file))
			.map((file) => `${file} is missing from the new unit set`),
		...coveredFiles
			.filter((file) => !legacySet.has(file))
			.map((file) => `${file} is extra in the new unit set`),
		...(coveredSet.size === coveredFiles.length
			? []
			: ["the new unit set contains duplicate file assignments"]),
		...shardInputProblems(
			rootFiles,
			ROOT_VITEST_SHARDS,
			"test:unit:root",
			plan.tasks,
		),
		...shardInputProblems(
			draftFiles,
			DRAFT_VITEST_SHARDS,
			"test:unit:draft",
			plan.tasks,
			selectDraftShard,
		),
	];
}
