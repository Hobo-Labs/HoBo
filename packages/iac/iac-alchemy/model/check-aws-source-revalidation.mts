import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertTlcExited,
	runBoundedTlc,
} from "../../../../scripts/lib/bounded-tlc.ts";

const configuredJar = process.env.HOBO_TLA_TOOLS;
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.7.4");
const jar = resolve(configuredJar);
const digest =
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
if (createHash("sha256").update(readFileSync(jar)).digest("hex") !== digest)
	throw new Error("TLA+ tool digest does not match the pinned release");
const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
	join(directory, "AwsSourceRevalidation.tla"),
	"utf8",
);
const config = readFileSync(
	join(directory, "AwsSourceRevalidation.cfg"),
	"utf8",
);
const scratch = mkdtempSync(join(tmpdir(), "hobo-aws-source-model-"));

function check(name: string, model: string, cfg: string, violation?: string) {
	const path = join(scratch, name);
	writeFileSync(`${path}.tla`, model.replaceAll("AwsSourceRevalidation", name));
	writeFileSync(`${path}.cfg`, cfg);
	const result = runBoundedTlc(
		jar,
		[
			"-workers",
			"1",
			"-metadir",
			`${path}-states`,
			"-config",
			`${path}.cfg`,
			`${path}.tla`,
		],
		scratch,
	);
	assertTlcExited(result);
	const output = `${result.stdout}\n${result.stderr}`;
	if (violation === undefined) {
		if (result.status !== 0 || !output.includes("No error has been found"))
			throw new Error(`${name} failed:\n${output}`);
		process.stdout.write(`${name}: checked\n`);
		return;
	}
	if (
		result.status === 0 ||
		!output.includes(`Invariant ${violation} is violated`)
	)
		throw new Error(`${name} did not violate ${violation}:\n${output}`);
	process.stdout.write(`${name}: ${violation} counterexample found\n`);
}

try {
	check("AwsSourceRevalidation", source, config);
	const cases = [
		[
			'phase = "verifying" /\\ source = "expected" /\\ authorized',
			'phase = "verifying" /\\ authorized',
			"StartedWithMatchingSource",
		],
		[
			'phase = "verifying" /\\ source = "expected" /\\ authorized',
			'phase = "verifying" /\\ source = "expected"',
			"StartedAuthorized",
		],
		[
			'phase \\in {"idle", "verifying", "inflight"} /\\ ~dispatched',
			'phase = "inflight" /\\ dispatched',
			"RejectedWithoutDispatch",
		],
		[
			'phase = "inflight" /\\ dispatched /\\ source = "expected" /\\ authorized',
			'phase = "inflight" /\\ source = "expected" /\\ authorized',
			"ReturnedAfterDispatch",
		],
		[
			'phase = "inflight" /\\ dispatched /\\ source = "expected" /\\ authorized',
			'phase = "inflight" /\\ dispatched /\\ authorized',
			"ReturnedWithMatchingSource",
		],
		[
			'phase = "inflight" /\\ dispatched /\\ source = "expected" /\\ authorized',
			'phase = "inflight" /\\ dispatched /\\ source = "expected"',
			"ReturnedAuthorized",
		],
	] as const;
	for (const [index, [before, after, invariant]] of cases.entries()) {
		if (source.split(before).length !== 2)
			throw new Error(`mutation target changed: ${before}`);
		check(
			`AwsSourceMutation${index}`,
			source.replace(before, after),
			config,
			invariant,
		);
	}
	for (const invariant of [
		"NoChangedSourceDispatch",
		"NoUnknownAfterDispatch",
		"NoUnknownBeforeDispatch",
		"NoRejectedOperation",
		"NoReturnedOperation",
	] as const)
		check(
			`AwsSourceWitness${invariant}`,
			source,
			`${config}\nINVARIANT ${invariant}\n`,
			invariant,
		);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
