#!/usr/bin/env node
/**
 * `pnpm run fleet:verify` (ADR-0182): runs every outcome of the fleet design
 * through `scripts/fleet-outcome.mts`, one process per outcome, and writes
 * `fleet-verification.json` at the root: one `{ id, pass, command, evidence,
 * measured, fallbacks }` object per outcome, in table order.
 *
 *   node --import tsx scripts/fleet-verify.mts [--root=<dir>] [--ids=O1,O2]
 *     [--include-deferred] [--out=<file>]
 *
 * O21 (checked at cutover) and O23 (checked when the deferred lane runs) are
 * left out unless `--include-deferred` is given. Exits 1 when any outcome it
 * ran did not pass.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OUTCOMES, type VerificationRecord } from "./fleet-outcome.mts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** Runs one outcome; `undefined` when it printed no verification object. */
export type OutcomeRunner = (id: string) => VerificationRecord | undefined;

/** The outcome ids a run covers: all, less the deferred ones unless asked. */
export function outcomeIds(
	options: Readonly<{
		ids?: readonly string[] | undefined;
		includeDeferred?: boolean;
	}>,
): string[] {
	if (options.ids !== undefined && options.ids.length > 0) {
		const unknown = options.ids.filter(
			(id) => !OUTCOMES.some((outcome) => outcome.id === id),
		);
		if (unknown.length > 0)
			throw new Error(`unknown outcome id(s): ${unknown.join(", ")}`);
		return [...options.ids];
	}
	return OUTCOMES.filter(
		(outcome) =>
			options.includeDeferred === true || outcome.deferred === undefined,
	).map((outcome) => outcome.id);
}

/** Runs each outcome in order; one that printed nothing is recorded as failed. */
export function verifyOutcomes(
	ids: readonly string[],
	runOne: OutcomeRunner,
): VerificationRecord[] {
	return ids.map((id) => {
		const record = runOne(id);
		if (record !== undefined && record.id === id) return record;
		const spec = OUTCOMES.find((outcome) => outcome.id === id);
		return {
			id,
			pass: false,
			command: spec?.checks.join("; ") ?? "",
			evidence: ["fleet:outcome printed no verification object"],
			measured: {},
			fallbacks: [],
		};
	});
}

/** Runs `fleet-outcome.mts <id>` against `root` and reads the object it prints. */
export function outcomeProcess(root: string): OutcomeRunner {
	return (id) => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				join(scriptsDir, "fleet-outcome.mts"),
				id,
				`--root=${root}`,
			],
			{
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "inherit"],
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		const line = (result.stdout ?? "")
			.split("\n")
			.map((entry) => entry.trim())
			.filter((entry) => entry.startsWith("{"))
			.at(-1);
		if (line === undefined) return undefined;
		try {
			// SAFETY: fleet-outcome.mts's own single-line verification object.
			return JSON.parse(line) as VerificationRecord;
		} catch {
			return undefined;
		}
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	const value = (name: string): string | undefined =>
		args
			.find((arg) => arg.startsWith(`--${name}=`))
			?.slice(`--${name}=`.length);
	const rootArg = value("root");
	const root = rootArg ? resolve(rootArg) : resolve(scriptsDir, "..");
	const ids = outcomeIds({
		ids: value("ids")
			?.split(",")
			.map((id) => id.trim())
			.filter((id) => id !== ""),
		includeDeferred: args.includes("--include-deferred"),
	});
	const records = verifyOutcomes(ids, outcomeProcess(root));
	const out = resolve(root, value("out") ?? "fleet-verification.json");
	writeFileSync(out, `${JSON.stringify(records, null, "\t")}\n`);
	const failed = records.filter((record) => !record.pass);
	process.stdout.write(
		`fleet:verify: ${records.length - failed.length}/${records.length} outcome(s) pass; wrote ${out}\n`,
	);
	for (const record of failed)
		process.stderr.write(`fleet:verify: ${record.id} did not pass\n`);
	if (failed.length > 0) process.exit(1);
}
