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
import { assertTlcExited, runBoundedTlc } from "./lib/bounded-tlc.ts";

const configuredJar = process.env.HOBO_TLA_TOOLS;
const expected =
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f";
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.8.0");
const jar = resolve(configuredJar);
if (createHash("sha256").update(readFileSync(jar)).digest("hex") !== expected)
	throw new Error("TLA+ tool digest does not match the pinned release");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const model = join(root, "packages/runtimes/runtime-rivet/model");
const source = readFileSync(join(model, "DurableTopic.tla"), "utf8");
const config = readFileSync(join(model, "DurableTopic.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-topic-model-"));

function replaceOnce(text: string, before: string, after: string): string {
	if (text.split(before).length !== 2)
		throw new Error("topic model mutation target changed");
	return text.replace(before, after);
}

function check(
	label: string,
	modelSource: string,
	modelConfig: string,
	expectedViolation?: string,
	moduleName = "DurableTopic",
): void {
	const directory = join(scratch, label);
	mkdirSync(directory);
	writeFileSync(join(directory, `${moduleName}.tla`), modelSource);
	writeFileSync(join(directory, `${moduleName}.cfg`), modelConfig);
	const result = runBoundedTlc(
		jar,
		[
			"-workers",
			"1",
			"-metadir",
			join(directory, "states"),
			"-config",
			`${moduleName}.cfg`,
			`${moduleName}.tla`,
		],
		directory,
	);
	assertTlcExited(result);
	const output = `${result.stdout}\n${result.stderr}`;
	if (expectedViolation === undefined) {
		if (result.status !== 0 || !output.includes("No error has been found"))
			throw new Error(`${label} failed:\n${output}`);
		const count = output.match(
			/\d+ states generated, \d+ distinct states found/u,
		);
		process.stdout.write(`${label}: ${count?.[0] ?? "checked"}\n`);
		return;
	}
	if (
		result.status === 0 ||
		!output.includes(`Invariant ${expectedViolation} is violated`)
	)
		throw new Error(
			`${label} did not violate ${expectedViolation}:\n${output}`,
		);
	process.stdout.write(`${label}: ${expectedViolation} counterexample found\n`);
}

try {
	check("capacity-four", source, config);
	check(
		"capacity-three",
		source,
		replaceOnce(config, "CONSTANT Capacity = 4", "CONSTANT Capacity = 3"),
	);
	check(
		"missing-reservation",
		replaceOnce(
			source,
			"reserve' = [reserve EXCEPT ![m] = TRUE]",
			"reserve' = [reserve EXCEPT ![m] = FALSE]",
		),
		config,
		"SourceObligationsReserved",
	);
	check(
		"blocked-final-transfer",
		replaceOnce(
			source,
			'/\\ source[m] = "leased" /\\ generation[m] = 2 /\\ reserve[m]',
			'/\\ source[m] = "leased" /\\ generation[m] = 2 /\\ reserve[m] /\\ Used < Capacity',
		),
		config,
		"FinalFailureEnabled",
	);
	check(
		"stale-lease",
		replaceOnce(
			source,
			'/\\ source[m] = "leased" /\\ token = generation[m]',
			'/\\ source[m] = "leased" /\\ token \\in 1..2',
		),
		config,
		"AcceptedCurrentLease",
	);
	check(
		"premature-compaction",
		replaceOnce(
			source,
			'/\\ source[m] \\in {"acked", "dead"}',
			'/\\ source[m] \\in {"pending", "leased", "acked", "dead"}',
		),
		config,
		"NoEarlyCompaction",
	);
	check(
		"dead-letter-out-of-order-compaction",
		replaceOnce(
			source,
			String.raw`  /\ \A earlier \in Messages :
       (deadOrder[earlier] > 0 /\ deadOrder[earlier] < deadOrder[m])
         => dead[earlier] = "compacted"
`,
			"",
		),
		config,
		"DeadCompactionIsPrefix",
	);
	check(
		"two-dead-letters-witness",
		source,
		`${config}\nINVARIANT NeverTwoDeadLetters\n`,
		"NeverTwoDeadLetters",
	);
	check(
		"full-final-lease-witness",
		source,
		`${config}\nINVARIANT NeverFullFinal\n`,
		"NeverFullFinal",
	);
	const declared = readFileSync(join(model, "DeclaredTopics.tla"), "utf8");
	const declaredConfig = readFileSync(
		join(model, "DeclaredTopics.cfg"),
		"utf8",
	);
	check(
		"declared-topics",
		declared,
		declaredConfig,
		undefined,
		"DeclaredTopics",
	);
	check(
		"declared-without-authority",
		replaceOnce(
			declared,
			'/\\ authority /\\ valid /\\ receipt = "none"',
			'/\\ valid /\\ receipt = "none"',
		),
		declaredConfig,
		"CreationAuthorized",
		"DeclaredTopics",
	);
	check(
		"declared-without-initialization",
		replaceOnce(declared, "topics' = Declared", "topics' = {}"),
		declaredConfig,
		"EffectIncludesTopics",
		"DeclaredTopics",
	);
	check(
		"declared-duplicate-replay",
		replaceOnce(
			declared,
			`  /\\ response' = receipt\n  /\\ UNCHANGED <<topics, effects, receipt, authority, valid, pinned, active,`,
			`  /\\ response' = receipt\n  /\\ effects' = IF receipt = "committed" /\\ effects < 2 THEN effects + 1 ELSE effects\n  /\\ UNCHANGED <<topics, receipt, authority, valid, pinned, active,`,
		),
		"SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT NoDuplicateEffect\n",
		"NoDuplicateEffect",
		"DeclaredTopics",
	);
	check(
		"declared-recovery-witness",
		declared,
		`${declaredConfig}\nINVARIANT NeverRecovered\n`,
		"NeverRecovered",
		"DeclaredTopics",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
