import { readFileSync, writeFileSync } from "node:fs";

import {
	DRAFT_VITEST_SHARDS,
	draftProofDirectory,
	draftUnitTestFiles,
	selectDraftShard,
} from "./lib/unit-test-selection.ts";

const files = draftUnitTestFiles();
const commonInputs = [
	"package.json",
	"vitest.config.ts",
	"test/setup/**",
	"scripts/**",
];
const trailingInputs = [
	"packages/runtimes/runtime-wasm/src/**",
	"packages/runtimes/runtime-wasm/test/wasmtime-global-setup.ts",
];

const tasks = Object.fromEntries(
	Array.from({ length: DRAFT_VITEST_SHARDS }, (_, index) => {
		const directories = [
			...new Set(
				selectDraftShard(files, {
					index,
					count: DRAFT_VITEST_SHARDS,
				}).map(draftProofDirectory),
			),
		].sort();
		return [
			`//#test:unit:draft:${index}`,
			{
				dependsOn: ["//#test:unit:dependencies"],
				inputs: [
					...commonInputs,
					...directories.map((directory) => `${directory}/**`),
					...trailingInputs,
				],
				outputs: [],
			},
		];
	}),
);
const turboBlock = `${JSON.stringify(tasks, null, 2)
	.split("\n")
	.slice(1, -1)
	.map((line) => `  ${line}`)
	.join("\n")},\n\n`;
const packageBlock = Array.from(
	{ length: DRAFT_VITEST_SHARDS },
	(_, index) =>
		`\t\t"test:unit:draft:${index}": "node --import tsx scripts/run-tests.ts --category=draft --quiet --final --shard=${index}/${DRAFT_VITEST_SHARDS}",\n`,
).join("");

function replaceBlock(
	source: string,
	start: string,
	end: string,
	replacement: string,
	file: string,
): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`cannot locate generated unit shard block in ${file}`);
	}
	return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

const outputs = [
	{
		file: "turbo.json",
		start: '    "//#test:unit:draft:0":',
		end: '    "dev":',
		replacement: turboBlock,
	},
	{
		file: "package.json",
		start: '\t\t"test:unit:draft:0":',
		end: '\t\t"test:visual":',
		replacement: packageBlock,
	},
];
const check = process.argv.includes("--check");
let drift = false;
for (const output of outputs) {
	const source = readFileSync(output.file, "utf8");
	const generated = replaceBlock(
		source,
		output.start,
		output.end,
		output.replacement,
		output.file,
	);
	if (generated === source) continue;
	drift = true;
	if (check) {
		console.error(`${output.file}: generated unit shard block is stale`);
	} else {
		writeFileSync(output.file, generated);
		console.log(`${output.file}: regenerated unit shard block`);
	}
}
if (check && drift) process.exitCode = 1;
else if (check) console.log("Unit shard generated files are up to date.");
