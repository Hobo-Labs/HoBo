import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configuredJar = process.env.HOBO_TLA_TOOLS;
const expected =
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f";
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.8.0");
const jar = resolve(configuredJar);
const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (actual !== expected)
	throw new Error("TLA+ tool digest does not match the pinned release");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "hobo-iac-models-"));
try {
	for (const [directory, name] of [
		["dispatcher", "IacRouting"],
		["broker", "IacBudget"],
		["cloud", "IacTransitions"],
	] as const) {
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"2",
				"-metadir",
				join(scratch, name),
				"-config",
				`${name}.cfg`,
				`${name}.tla`,
			],
			{
				cwd: join(root, "packages", directory, "model"),
				stdio: "inherit",
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${name} model checking failed`);
	}
	// Check that representative removals of safety guards produce counterexamples.
	const mutations = [
		[
			"broker",
			"IacBudget",
			"/\\ guard \\in BOOLEAN /\\ (settlementTrust \\/ guard)",
			"/\\ guard \\in BOOLEAN",
		],
		[
			"broker",
			"IacBudget",
			'/\\ mode[o] # "priced" \\/ settlementTrust \\/ guarded[o]',
			"/\\ TRUE",
		],
		[
			"broker",
			"IacBudget",
			'/\\ status[o] = "idle" /\\ ActiveUnpriced = {}',
			'/\\ status[o] = "idle"',
		],
		[
			"broker",
			"IacBudget",
			"/\\ fenced[o] /\\ verified[o] /\\ ~live[o] /\\ actual \\in 0..3",
			"/\\ actual \\in 0..3",
		],
		[
			"dispatcher",
			"IacRouting",
			'/\\ phase = "uncertain" /\\ candidate \\in fenced /\\ candidate \\notin live\n  /\\ verified\' = TRUE',
			'/\\ phase = "uncertain"\n  /\\ verified\' = TRUE',
		],
		[
			"cloud",
			"IacTransitions",
			"StartApply(c) ==\n  /\\ snapshot[c] = version /\\ version < MaxVersion",
			"StartApply(c) ==\n  /\\ version < MaxVersion",
		],
		[
			"cloud",
			"IacTransitions",
			'/\\ apply = "uncertain" /\\ fenced /\\ verified /\\ live = "none"\n  /\\ result',
			'/\\ apply = "uncertain"\n  /\\ result',
		],
	] as const;
	for (const [index, [directory, name, before, after]] of mutations.entries()) {
		const original = join(root, "packages", directory, "model");
		const source = readFileSync(join(original, `${name}.tla`), "utf8");
		if (source.split(before).length !== 2)
			throw new Error(`${name} mutation target changed`);
		const isolated = join(scratch, `mutation-${index}`);
		mkdirSync(isolated);
		writeFileSync(join(isolated, `${name}.tla`), source.replace(before, after));
		writeFileSync(
			join(isolated, `${name}.cfg`),
			readFileSync(join(original, `${name}.cfg`)),
		);
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"2",
				"-metadir",
				join(isolated, "states"),
				"-config",
				`${name}.cfg`,
				`${name}.tla`,
			],
			{ cwd: isolated, encoding: "utf8" },
		);
		if (result.error) throw result.error;
		if (result.status === 0 || !/Invariant .+ is violated/u.test(result.stdout))
			throw new Error(
				`${name} mutation did not produce an invariant counterexample`,
			);
		process.stdout.write(
			`${name} mutation ${index + 1}: counterexample found\n`,
		);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
