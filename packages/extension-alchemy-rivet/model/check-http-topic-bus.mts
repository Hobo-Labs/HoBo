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
if (!configured) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.8.0");
const jar = resolve(configured);
if (
	createHash("sha256").update(readFileSync(jar)).digest("hex") !==
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f"
)
	throw new Error("TLA+ tool digest does not match the pinned release");
const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "RivetHttpTopicBus.tla"), "utf8");
const config = readFileSync(join(root, "RivetHttpTopicBus.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-rivet-http-topic-bus-"));

function check(name: string, model: string, cfg: string, violation?: string) {
	const base = join(scratch, name);
	writeFileSync(`${base}.tla`, model.replaceAll("RivetHttpTopicBus", name));
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

function replaceOnce(before: string, after: string): string {
	if (source.split(before).length !== 2)
		throw new Error("model mutation target changed");
	return source.replace(before, after);
}

try {
	check("RivetHttpTopicBus", source, config);
	const mutations = [
		[
			"MissingAdmissionAuth",
			"  /\\ authorized /\\ scopeValid /\\ ~dispatched",
			"  /\\ scopeValid /\\ ~dispatched",
			"DispatchAuthorized",
		],
		[
			"MissingAdmissionScope",
			"  /\\ authorized /\\ scopeValid /\\ ~dispatched",
			"  /\\ authorized /\\ ~dispatched",
			"DispatchAuthorized",
		],
		[
			"UnboundEffect",
			"  /\\ dispatched /\\ ~effect",
			"  /\\ ~effect",
			"EffectWasDispatched",
		],
		[
			"MissingDisclosureAuth",
			"  /\\ authorized /\\ scopeValid /\\ effect /\\ ~disclosed /\\ ~unknown",
			"  /\\ scopeValid /\\ effect /\\ ~disclosed /\\ ~unknown",
			"DisclosureAuthorized",
		],
		[
			"MissingDisclosureScope",
			"  /\\ authorized /\\ scopeValid /\\ effect /\\ ~disclosed /\\ ~unknown",
			"  /\\ authorized /\\ effect /\\ ~disclosed /\\ ~unknown",
			"DisclosureAuthorized",
		],
		[
			"DisclosureAfterTimeout",
			"  /\\ authorized /\\ scopeValid /\\ effect /\\ ~disclosed /\\ ~unknown",
			"  /\\ authorized /\\ scopeValid /\\ effect /\\ ~disclosed",
			"NoAmbiguousDisclosure",
		],
	] as const;
	for (const [name, before, after, invariant] of mutations)
		check(name, replaceOnce(before, after), config, invariant);
	for (const invariant of [
		"NeverDisclosed",
		"NeverUnknown",
		"NeverLateEffect",
	] as const)
		check(
			`Witness${invariant}`,
			source,
			`${config}\nINVARIANT ${invariant}\n`,
			invariant,
		);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
