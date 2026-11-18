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
const expected =
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f";
if (createHash("sha256").update(readFileSync(jar)).digest("hex") !== expected)
	throw new Error("TLA+ tool digest does not match the pinned release");
const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(directory, "RivetHttpQueue.tla"), "utf8");
const config = readFileSync(join(directory, "RivetHttpQueue.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-http-queue-model-"));

function replaceOnce(text: string, before: string, after: string): string {
	if (text.split(before).length !== 2)
		throw new Error("HTTP/queue model mutation target changed");
	return text.replace(before, after);
}

function check(
	name: string,
	model: string,
	configuration: string,
	violation?: string,
): void {
	const path = join(scratch, name);
	writeFileSync(`${path}.tla`, model.replaceAll("RivetHttpQueue", name));
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
	check("HttpQueue", source, config);
	check(
		"QueueRetry",
		replaceOnce(source, "/\\ s.sent = 0 /\\ s.sent < 2", "/\\ s.sent < 2"),
		config,
		"AtMostOneDispatch",
	);
	const rejectedAdmission = replaceOnce(
		source,
		'!.phase = IF decision = "allow" THEN "running" ELSE "done",',
		'!.phase = "running",',
	);
	check(
		"QueueDispatchWithoutAdmission",
		replaceOnce(
			rejectedAdmission,
			'/\\ s.phase = "running" /\\ s.pre = "allow" /\\ s.scope',
			'/\\ s.phase = "running" /\\ s.scope',
		),
		config,
		"DispatchRequiresAdmission",
	);
	check(
		"QueueLostReceiptAsSuccess",
		replaceOnce(
			source,
			'!.outcome = "unknown", !.phase = "result"]\n\nRejectEnqueue',
			'!.outcome = "ok", !.phase = "result"]\n\nRejectEnqueue',
		),
		config,
		"SuccessRequiresReceipt",
	);
	const marker = "\nPostAuthorization ==";
	const [before, after] = source.split(marker);
	if (
		before === undefined ||
		after === undefined ||
		source.split(marker).length !== 2
	)
		throw new Error("HTTP/queue post-authorization target changed");
	check(
		"QueueDisclosureWithoutAuthority",
		before +
			marker +
			replaceOnce(
				after,
				'/\\ decision = "allow" => (s.scope /\\ s.principal)',
				"/\\ TRUE",
			),
		config,
		"DisclosureRequiresAuthorization",
	);
	check(
		"QueueEffectAfterFence",
		replaceOnce(
			source,
			"CommitEnqueue ==\n  /\\ s.inFlight /\\ ~s.fenced",
			"CommitEnqueue ==\n  /\\ s.inFlight",
		),
		config,
		"NoEffectAfterFence",
	);
	check(
		"QueueRetireWithoutFence",
		replaceOnce(
			source,
			'/\\ ((s.outcome # "unknown" /\\ s.response \\notin {"denied-after", "unavailable-after"}) \\/ (s.fenced /\\ s.drained))',
			"/\\ TRUE",
		),
		replaceOnce(config, "INVARIANT SuppressedRetirementRequiresFence\n", ""),
		"UnknownRetirementRequiresFence",
	);
	check(
		"QueueRetireSuppressedWithoutFence",
		replaceOnce(
			source,
			'/\\ ((s.outcome # "unknown" /\\ s.response \\notin {"denied-after", "unavailable-after"}) \\/ (s.fenced /\\ s.drained))',
			"/\\ TRUE",
		),
		replaceOnce(config, "INVARIANT UnknownRetirementRequiresFence\n", ""),
		"SuppressedRetirementRequiresFence",
	);
	check(
		"QueueRetirePendingCallback",
		replaceOnce(
			source,
			"/\\ ~s.inFlight /\\ ~s.prePending /\\ ~s.postPending /\\ ~s.verifierPending",
			"/\\ TRUE",
		),
		config,
		"RetirementRequiresNoPendingWork",
	);
	for (const witness of [
		"NeverUnknownBeforeDispatch",
		"NeverUnknownAfterCommit",
		"NeverLateCommit",
		"NeverDeniedAfterCommit",
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
