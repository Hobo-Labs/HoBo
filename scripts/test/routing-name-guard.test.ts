import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;

export const ROUTING_NAMES: readonly string[] = Object.freeze([
	"HOBO_CI_ROUTE",
	"HOBO_CI_ROUTE_MAX_WAIT_SECONDS",
	"HOBO_CI_ROUTE_MAX_QUEUED",
	"HOBO_CI_TRUNK_RUNNER",
	"HOBO_CI_LOCAL_RUNNER",
	"HOBO_CI_INCLUDE_OWN_RUN",
	"HOBO_CI_ATTESTED",
	"HOBO_CI_FLEET_ROUTES",
	"HOBO_CI_FLEET_REPORTER_ID",
	"HOBO_CI_FLEET_EXTERNAL_POOLS_JSON",
	"HOBO_CI_FLEET_REPORTERS_JSON",
	"HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB",
	"HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS",
	"HOBO_CI_WORKER_SLOTS",
	"HOBO_CI_WORKER_TRUNK_SLOTS",
	"HOBO_CI_WORKER_TRUNK_LEND",
	"HOBO_CI_WORKER_PR_CAP_WITH_TRUNK",
	"HOBO_CI_WORKER_MERGE_GROUP_LEASES",
	"HOBO_CI_JOB_ADMISSION",
	"MAIN_WORKSPACE_PARALLEL_CAP",
	"HOBO_CI_BOX_RUNNER",
	"HOBO_CI_MAIN_REUSE_MERGE_QUEUE",
	"HOBO_CI_TURBO_API",
]);
export const ROUTING_NAME_PREFIXES: readonly string[] = Object.freeze([
	"HOBO_CI_FLEET_VERDICT_",
]);

const SCOPES = [
	"scripts",
	".github",
	"packages/ci-gh-actions/templates",
	...readdirSync(join(ROOT, "packages"))
		.filter(
			(name) =>
				name === "ci" ||
				name.startsWith("ci-") ||
				name === "fleet" ||
				name.startsWith("fleet-"),
		)
		.map((name) => `packages/${name}`),
];
const SKIP_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	".turbo",
	"_generated",
	"coverage",
]);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|ya?ml|sh|json)$/u;

const FIXTURE_FILES = new Set([
	"scripts/test/routing-name-guard.test.ts",
	"scripts/test/lint-actions-runner.test.ts",
]);
const FIXTURE_DIRECTORIES: readonly string[] = [
	"scripts/test/fixtures/fleet-vocabulary/",
];
const NOT_ROUTING_ON_THE_LIST = new Set([
	"HOBO_CI_CONFIG",
	"HOBO_CI_CONFIG_JSON",
]);

function* sourceFiles(directory: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(join(ROOT, directory));
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRECTORIES.has(entry)) continue;
		const path = `${directory}/${entry}`;
		const stats = statSync(join(ROOT, path));
		if (stats.isDirectory()) yield* sourceFiles(path);
		else if (SOURCE.test(entry)) yield path;
	}
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const NAME = `(?:${[
	...ROUTING_NAMES.map((name) => `${escape(name)}(?![A-Z0-9_])`),
	...ROUTING_NAME_PREFIXES.map((prefix) => `${escape(prefix)}[A-Z0-9_]+`),
].join("|")})`;

export function routingReads(
	path: string,
	text: string,
): { kind: string; name: string; line: number }[] {
	const found: { kind: string; name: string; line: number }[] = [];
	const patterns: readonly [string, RegExp][] = [
		[
			"env read",
			new RegExp(
				`\\benv(?:\\.(${NAME})|\\[\\s*["'\`](${NAME})["'\`]\\s*\\])(?!\\s*=[^=])`,
				"gu",
			),
		],
		["vars", new RegExp(`\\bvars\\.(${NAME})`, "gu")],
	];
	const yaml = /\.ya?ml$/u.test(path);
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		for (const [kind, pattern] of patterns)
			for (const match of line.matchAll(pattern)) {
				const name = match[1] ?? match[2];
				if (name) found.push({ kind, name, line: index + 1 });
			}
		if (yaml) {
			const key = new RegExp(
				`^\\s*(?:-\\s*)?["']?(${NAME})["']?\\s*:`,
				"u",
			).exec(line);
			if (key?.[1])
				found.push({ kind: "yaml key", name: key[1], line: index + 1 });
		}
	});
	return found;
}

describe("no routing name is read from the environment or a variable (ADR-0181, M2)", () => {
	it("scans the plan's scope", () => {
		const files = SCOPES.flatMap((scope) => [...sourceFiles(scope)]);
		assert.ok(files.length > 500, `only ${files.length} files scanned`);
		for (const expected of [
			"scripts/ci/route-runner.mts",
			"packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts",
			".github/workflows/hobo-ci.yml",
			".github/actions/route-runner/action.yml",
			"packages/ci-gh-actions/templates/hobo-ci-smoke.yml",
		])
			assert.ok(files.includes(expected), expected);
	});

	it("finds none outside the allowed reads", () => {
		const offenders: string[] = [];
		for (const scope of SCOPES)
			for (const file of sourceFiles(scope)) {
				if (
					FIXTURE_FILES.has(file) ||
					FIXTURE_DIRECTORIES.some((directory) => file.startsWith(directory))
				)
					continue;
				for (const read of routingReads(
					file,
					readFileSync(join(ROOT, file), "utf8"),
				))
					offenders.push(`${file}:${read.line} ${read.kind} ${read.name}`);
			}
		assert.deepEqual(offenders, []);
	});

	it("catches each kind of read, and lets an assignment and a literal pass", () => {
		const reads = (path: string, text: string) =>
			routingReads(path, text).map((read) => `${read.kind} ${read.name}`);
		assert.deepEqual(
			reads("a.ts", "const x = process.env.HOBO_CI_WORKER_SLOTS;"),
			["env read HOBO_CI_WORKER_SLOTS"],
		);
		assert.deepEqual(reads("a.ts", 'env["HOBO_CI_ROUTE_MAX_QUEUED"] ?? "4"'), [
			"env read HOBO_CI_ROUTE_MAX_QUEUED",
		]);
		assert.deepEqual(
			reads("a.yml", "runs-on: ${{ vars.HOBO_CI_TRUNK_RUNNER }}"),
			["vars HOBO_CI_TRUNK_RUNNER"],
		);
		assert.deepEqual(reads("a.yml", "  if: env.HOBO_CI_FLEET_VERDICT_URL"), [
			"env read HOBO_CI_FLEET_VERDICT_URL",
		]);
		assert.deepEqual(reads("a.yml", "      MAIN_WORKSPACE_PARALLEL_CAP: 4"), [
			"yaml key MAIN_WORKSPACE_PARALLEL_CAP",
		]);
		assert.deepEqual(reads("a.yml", "      HOBO_CI_INCLUDE_OWN_RUN: true"), [
			"yaml key HOBO_CI_INCLUDE_OWN_RUN",
		]);
		assert.deepEqual(
			reads("a.ts", 'process.env.HOBO_CI_WORKER_SLOTS = "3";'),
			[],
		);
		assert.deepEqual(reads("a.ts", '"HOBO_CI_FLEET_ROUTES",'), []);
		assert.deepEqual(
			reads("a.ts", "process.env.HOBO_CI_ROUTE_SOMETHING_ELSE"),
			[],
		);
		assert.deepEqual(reads("a.yml", "HOBO_CI_RELAY_URL: x"), []);
		assert.deepEqual(reads("a.yml", "HOBO_CI_MERGE_QUEUE_BRANCH: main"), []);
	});

	it("guards every name on ADR-0181's routing list, and only names the ADR gives", () => {
		const adr = readFileSync(
			join(ROOT, "docs/design/adr/routing-slips.md"),
			"utf8",
		);
		const start = adr.indexOf("### Routing list");
		const end = adr.indexOf("Not routing:", start);
		assert.ok(start >= 0 && end > start, "the ADR's routing list moved");
		const listed = new Set(
			[
				...adr
					.slice(start, end)
					.matchAll(/`((?:HOBO_CI|MAIN)_[A-Z0-9_]+\*?)`/gu),
			]
				.map((match) => match[1] ?? "")
				.filter((name) => !NOT_ROUTING_ON_THE_LIST.has(name)),
		);
		const guarded = [
			...ROUTING_NAMES,
			...ROUTING_NAME_PREFIXES.map((prefix) => `${prefix}*`),
		];
		for (const name of listed) assert.ok(guarded.includes(name), name);
		for (const name of guarded)
			assert.ok(adr.includes(`\`${name}\``), `${name} is not in ADR-0181`);
	});
});
