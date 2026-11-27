import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertTlcExited,
	runBoundedTlc,
} from "../../../scripts/lib/bounded-tlc.ts";

const configured = process.env.HOBO_TLA_TOOLS;
if (!configured) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.7.4");
const jar = resolve(configured);
if (
	createHash("sha256").update(readFileSync(jar)).digest("hex") !==
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
)
	throw new Error("TLA+ tool digest does not match the pinned release");
const root = dirname(fileURLToPath(import.meta.url));
const model = readFileSync(join(root, "TopicProvisioning.tla"), "utf8");
const config = readFileSync(join(root, "TopicProvisioning.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-topic-provisioning-"));
function replaceOnce(source: string, before: string, after: string): string {
	if (source.split(before).length !== 2)
		throw new Error("model mutation target changed");
	return source.replace(before, after);
}
function check(name: string, source: string, cfg: string, invariant?: string) {
	const base = join(scratch, name);
	writeFileSync(`${base}.tla`, source.replaceAll("TopicProvisioning", name));
	writeFileSync(`${base}.cfg`, cfg);
	const result = runBoundedTlc(
		jar,
		[
			"-workers",
			"1",
			"-metadir",
			`${base}-states`,
			"-config",
			`${base}.cfg`,
			`${base}.tla`,
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
	check("TopicProvisioning", model, config);
	check(
		"MissingAuthorization",
		replaceOnce(model, '/\\ phase = "new" /\\ allowed', '/\\ phase = "new"'),
		config,
		"OnlyAuthorizedStarts",
	);
	const overtake = replaceOnce(
		replaceOnce(
			model,
			"/\\ phase' = \"uncertain\" /\\ unresolved' = cursor /\\ unknownEpoch' = operationEpoch",
			"/\\ phase' = \"running\" /\\ unresolved' = cursor /\\ unknownEpoch' = operationEpoch /\\ cursor' = cursor + 1",
		),
		"UNCHANGED <<cursor, confirmed, allowed, admitted, operationEpoch, retryStable>>",
		"UNCHANGED <<confirmed, allowed, admitted, operationEpoch, retryStable>>",
	);
	check("OvertakeUnknown", overtake, config, "NoOvertakeUnknown");
	check(
		"ChangeRetryOperation",
		replaceOnce(
			model,
			"/\\ phase' = \"running\"\n  /\\ retryStable' = (operationEpoch = unknownEpoch)",
			"/\\ phase' = \"running\"\n  /\\ retryStable' = ((1 - operationEpoch) = unknownEpoch)",
		),
		config,
		"RetryUsesSameOperation",
	);
	check(
		"WitnessComplete",
		model,
		`${config}\nINVARIANT NeverCompleted\n`,
		"NeverCompleted",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
