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
const source = readFileSync(join(root, "TopicPolicy.tla"), "utf8");
const config = readFileSync(join(root, "TopicPolicy.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-topic-policy-"));

function replaceOnce(text: string, before: string, after: string): string {
	if (text.split(before).length !== 2)
		throw new Error("topic policy mutation target changed");
	return text.replace(before, after);
}

function check(label: string, model: string, cfg: string, violation?: string) {
	const base = join(scratch, label);
	writeFileSync(`${base}.tla`, model.replaceAll("TopicPolicy", label));
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
			throw new Error(`${label} failed:\n${output}`);
		const count = output.match(
			/\d+ states generated, \d+ distinct states found/u,
		);
		process.stdout.write(`${label}: ${count?.[0] ?? "checked"}\n`);
	} else {
		if (
			result.status === 0 ||
			!output.includes(`Invariant ${violation} is violated`)
		)
			throw new Error(`${label} did not violate ${violation}:\n${output}`);
		process.stdout.write(`${label}: ${violation} counterexample found\n`);
	}
}

try {
	check("TopicPolicy", source, config);
	for (const [label, replacement] of [
		[
			"MissingTopic",
			'Allowed == /\\ method \\in {"publish", "subscribe"} /\\ (method # "subscribe" \\/ destination = "dlq")',
		],
		[
			"MissingMethod",
			'Allowed == /\\ topic = "orders" /\\ (method # "subscribe" \\/ destination = "dlq")',
		],
		[
			"MissingDestination",
			'Allowed == /\\ topic = "orders" /\\ method \\in {"publish", "subscribe"}',
		],
	] as const)
		check(
			label,
			replaceOnce(source, "Allowed == Expected", replacement),
			config,
			"DispatchAuthorized",
		);
	check(
		"MissingRevocation",
		replaceOnce(
			source,
			"/\\ active /\\ verified /\\ Allowed /\\ ~dispatched",
			"/\\ verified /\\ Allowed /\\ ~dispatched",
		),
		config,
		"DispatchAuthorized",
	);
	for (const invariant of [
		"NeverAllowedPublish",
		"NeverAllowedSubscribe",
		"NeverUnknownCommit",
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
