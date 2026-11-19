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
const source = readFileSync(join(directory, "CloudflareSecret.tla"), "utf8");
const config = readFileSync(join(directory, "CloudflareSecret.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-cloudflare-secret-model-"));

function check(name: string, model: string, cfg: string, violation?: string) {
	const path = join(scratch, name);
	writeFileSync(`${path}.tla`, model.replaceAll("CloudflareSecret", name));
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
	check("CloudflareSecret", source, config);
	const cases = [
		["/\\ storeKnown\n", "/\\ TRUE\n", "MappedNeedsStore"],
		["/\\ valueRedacted\n", "/\\ TRUE\n", "MappedNeedsRedaction"],
		["/\\ uniqueIdentity\n", "/\\ TRUE\n", "MappedNeedsUniqueIdentity"],
		["/\\ ~runtimeRequested\n", "/\\ TRUE\n", "MappedRejectsRuntime"],
		[
			"IF fingerprintVerified /\\ inventoryMatches",
			"IF TRUE",
			"PreviewNeedsEvidence",
		],
	] as const;
	for (const [index, [before, after, invariant]] of cases.entries()) {
		if (source.split(before).length !== 2)
			throw new Error(`secret mutation target changed: ${before}`);
		check(
			`SecretMutation${index}`,
			source.replace(before, after),
			config,
			invariant,
		);
	}
	for (const invariant of ["NoMapping", "NoPreview", "NoRefusal"] as const)
		check(
			`SecretWitness${invariant}`,
			source,
			`${config}\nINVARIANT ${invariant}\n`,
			invariant,
		);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
