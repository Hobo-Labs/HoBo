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

function check(
	label: string,
	model: string,
	cfg: string,
	violation?: string,
	moduleName = "TopicPolicy",
) {
	const base = join(scratch, label);
	writeFileSync(`${base}.tla`, model.replaceAll(moduleName, label));
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
	const bindle = readFileSync(join(root, "BindleTopicGrants.tla"), "utf8");
	const bindleConfig = readFileSync(
		join(root, "BindleTopicGrants.cfg"),
		"utf8",
	);
	check(
		"BindleTopicGrants",
		bindle,
		bindleConfig,
		undefined,
		"BindleTopicGrants",
	);
	check(
		"MissingEdges",
		replaceOnce(
			bindle,
			"Valid == edges = bindings /\\ DistinctNames",
			"Valid == DistinctNames",
		),
		bindleConfig,
		"NoUndeclaredGrant",
		"BindleTopicGrants",
	);
	check(
		"MissingAliasCheck",
		replaceOnce(
			bindle,
			"Valid == edges = bindings /\\ DistinctNames",
			"Valid == edges = bindings",
		),
		bindleConfig,
		"NoAliasedTopics",
		"BindleTopicGrants",
	);
	check(
		"ExtraVerbs",
		replaceOnce(
			bindle,
			"THEN permissions[r] ELSE {}",
			'THEN {"publish", "subscribe"} ELSE {}',
		),
		bindleConfig,
		"NoUndeclaredVerbs",
		"BindleTopicGrants",
	);
	check(
		"WitnessBindleGranted",
		bindle,
		`${bindleConfig}\nINVARIANT NeverGranted\n`,
		"NeverGranted",
		"BindleTopicGrants",
	);
	const client = readFileSync(join(root, "BindleTopicClient.tla"), "utf8");
	const clientConfig = readFileSync(
		join(root, "BindleTopicClient.cfg"),
		"utf8",
	);
	check(
		"BindleTopicClient",
		client,
		clientConfig,
		undefined,
		"BindleTopicClient",
	);
	check(
		"CallerChoosesTopic",
		replaceOnce(
			client,
			"topic' = IF requested \\in Resources THEN Physical[requested] ELSE suppliedTopic",
			"topic' = suppliedTopic",
		),
		clientConfig,
		"CorrectTopic",
		"BindleTopicClient",
	);
	check(
		"CallerChoosesDestination",
		replaceOnce(
			client,
			"IF requested \\in Resources THEN Destination[requested] ELSE suppliedDead",
			"suppliedDead",
		),
		clientConfig,
		"CorrectDestination",
		"BindleTopicClient",
	);
	check(
		"CallerChoosesGroup",
		replaceOnce(client, '(method = "publish" \\/ group = "workers")', "TRUE"),
		clientConfig,
		"CorrectGroup",
		"BindleTopicClient",
	);
	check(
		"MissingResourceBinding",
		replaceOnce(
			client,
			"~dispatched /\\ requested \\in Resources",
			"~dispatched",
		),
		clientConfig,
		"NoUnknownResource",
		"BindleTopicClient",
	);
	check(
		"WitnessClientDispatch",
		client,
		`${clientConfig}\nINVARIANT NeverDispatched\n`,
		"NeverDispatched",
		"BindleTopicClient",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
