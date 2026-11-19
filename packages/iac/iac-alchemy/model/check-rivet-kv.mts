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
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.8.0");
const jar = resolve(configuredJar);
const digest =
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f";
if (createHash("sha256").update(readFileSync(jar)).digest("hex") !== digest)
	throw new Error("TLA+ tool digest does not match the pinned release");
const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(directory, "RivetKv.tla"), "utf8");
const config = readFileSync(join(directory, "RivetKv.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-rivet-kv-model-"));

function replaceOnce(text: string, before: string, after: string): string {
	if (text.split(before).length !== 2)
		throw new Error("Rivet key-value model mutation target changed");
	return text.replace(before, after);
}

function check(
	name: string,
	model: string,
	configuration: string,
	violation?: string,
): void {
	const path = join(scratch, name);
	writeFileSync(`${path}.tla`, model.replaceAll("RivetKv", name));
	writeFileSync(`${path}.cfg`, configuration);
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
		const states = output.match(
			/\d+ states generated, \d+ distinct states found/u,
		);
		process.stdout.write(`${name}: ${states?.[0] ?? "checked"}\n`);
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
	check("Kv", source, config);
	check(
		"KvRetry",
		replaceOnce(source, "Retry ==\n  /\\ FALSE", "Retry ==\n  /\\ TRUE"),
		config,
		"AtMostOneDispatch",
	);
	check(
		"KvFalseSuccess",
		replaceOnce(
			source,
			'!.phase = "done", !.outcome = "unknown"]\n\nReject ==',
			'!.phase = "done", !.outcome = "success"]\n\nReject ==',
		),
		config,
		"SuccessRequiresReceipt",
	);
	check(
		"KvEffectAfterFence",
		replaceOnce(
			source,
			"Commit ==\n  /\\ s.inFlight /\\ ~s.fenced",
			"Commit ==\n  /\\ s.inFlight",
		),
		config,
		"NoEffectAfterFence",
	);
	for (const witness of [
		"NeverLateCommit",
		"NeverLostCommittedReceipt",
		"NeverRetiredUnknown",
	] as const)
		check(
			`Witness${witness}`,
			source,
			`${config}\nINVARIANT ${witness}\n`,
			witness,
		);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
