import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertTlcExited,
	runBoundedTlc,
} from "../../../../scripts/lib/bounded-tlc.ts";

const configured = process.env.HOBO_TLA_TOOLS;
if (!configured) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.7.4");
const jar = resolve(configured);
if (
	createHash("sha256").update(readFileSync(jar)).digest("hex") !==
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
)
	throw new Error("TLA+ tool digest does not match the pinned release");
const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(directory, "HttpUiMapping.tla"), "utf8");
const config = readFileSync(join(directory, "HttpUiMapping.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-http-ui-model-"));
function check(name: string, model: string, cfg: string, invariant?: string) {
	const path = join(scratch, name);
	writeFileSync(`${path}.tla`, model.replaceAll("HttpUiMapping", name));
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
	if (invariant) {
		if (
			result.status === 0 ||
			!output.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`${name} did not produce ${invariant}:\n${output}`);
		process.stdout.write(`${name}: ${invariant} counterexample found\n`);
	} else {
		if (result.status !== 0 || !output.includes("No error has been found"))
			throw new Error(`${name} failed:\n${output}`);
		process.stdout.write(
			`${name}: ${output.match(/\d+ states generated, \d+ distinct states found/u)?.[0] ?? "checked"}\n`,
		);
	}
}
try {
	check("HttpUiMapping", source, config);
	for (const [index, [before, invariant]] of [
		['/\\ (kind # "ui" \\/ operation = "none")', "UiOperationsNotMapped"],
		["/\\ sourceAttested\n  /\\ ~replayEnabled", "MappingNeedsSource"],
		["/\\ ~replayEnabled\n  /\\ (kind #", "MappingDisablesReplay"],
	].entries()) {
		if (source.split(before).length !== 2)
			throw new Error("model mutation target changed");
		const after =
			index === 0
				? "/\\ TRUE"
				: index === 1
					? "/\\ TRUE\n  /\\ ~replayEnabled"
					: "/\\ TRUE\n  /\\ (kind #";
		check(
			`HttpUiMutation${index}`,
			source.replace(before, after),
			config,
			invariant,
		);
	}
	for (const invariant of [
		"NoAwsUi",
		"NoRivetUi",
		"NoCloudflareUi",
		"NoUiRejection",
	])
		check(
			`HttpUiWitness${invariant}`,
			source,
			`${config}\nINVARIANT ${invariant}\n`,
			invariant,
		);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
