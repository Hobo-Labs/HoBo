#!/usr/bin/env -S node --no-warnings
// A stand-in for `opensesame dev --agent --schema <file> run -- <cmd...>`.
//
// It models what the real binary does today, line for line (apps/cli/src
// dev_run.rs, dev_surrogate.rs, dev_credentials.rs, dev_supervise.rs): it takes
// exactly that argv, reads the schema it was given, never hands the child the
// store passphrase, and for the scenario named by FAKE_OPENSESAME_SCENARIO it
// delivers a surrogate or a placeholder, refuses, or ends the run as a
// tripwire or a signal does. It records what it was given in
// FAKE_OPENSESAME_RECORD. The lines it prints are the real ones
// (test/fixtures/opensesame-lines.ts). The real lane (test/real) replays the
// same scenarios against the real binary, which is the only thing that says this
// model is right.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { SAMPLE_LINES, type SampleScenario } from "./opensesame-lines.ts";

const argv = process.argv.slice(2);

// What the adapter asks before it hands over the passphrase (the real tool prints `opensesame 0.1.0`).
if (argv[0] === "--version") {
	process.stdout.write("opensesame 0.1.0\n");
	process.exit(0);
}

const scenario = process.env.FAKE_OPENSESAME_SCENARIO ?? "surrogate-delivered";
if (process.env.FAKE_OPENSESAME_PIDFILE !== undefined) {
	writeFileSync(process.env.FAKE_OPENSESAME_PIDFILE, String(process.pid));
}
const recordPath = process.env.FAKE_OPENSESAME_RECORD;

function usage(): never {
	process.stderr.write(
		`error: unexpected arguments: ${argv.length} given, wanted dev --agent --schema <file> run -- <cmd...>\n`,
	);
	process.exit(2);
}

const [dev, agent, schemaFlag, schemaPath, run, dashes, ...command] = argv;
if (
	dev !== "dev" ||
	agent !== "--agent" ||
	schemaFlag !== "--schema" ||
	schemaPath === undefined ||
	run !== "run" ||
	dashes !== "--" ||
	command.length === 0
) {
	usage();
}

const schema = readFileSync(schemaPath, "utf8");
if (recordPath !== undefined) {
	writeFileSync(
		recordPath,
		JSON.stringify({
			argv,
			schema,
			schemaMode: (statSync(schemaPath).mode & 0o777).toString(8),
			schemaDirMode: (statSync(dirname(schemaPath)).mode & 0o777).toString(8),
			schemaPath,
			sawStorePassword: process.env.OPENSESAME_STORE_PASSWORD !== undefined,
			sawNodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,
			sawChildMarker: process.env.HOBO_OPENSESAME_CHILD,
			sawEnvParse: process.env.OPENSESAME_ENV_PARSE,
		}),
	);
}

function say(name: SampleScenario): void {
	process.stderr.write(`${SAMPLE_LINES[name].join("\n")}\n`);
}

function refuse(name: SampleScenario): never {
	say(name);
	process.exit(1);
}

// The same refusals the real tool makes from the schema alone.
if (!schema.includes("opensesameConnection(")) {
	process.stderr.write(
		"Error: env-spec parse failed: bridge failed: no entries\n",
	);
	process.exit(1);
}
if (!schema.includes("paths=")) refuse("scope-unbounded");
if (!schema.includes("methods=")) refuse("paths-without-methods");

if (scenario === "plugin-changed") refuse("plugin-changed");
if (scenario === "wrong-passphrase") refuse("wrong-passphrase");
if (scenario === "empty-entry") refuse("empty-entry");
if (scenario === "bridge-no-parser") refuse("bridge-no-parser");

const names = [
	...schema.matchAll(/^([A-Z][A-Z0-9_]*)=opensesameConnection\(/gmu),
].map((match) => match[1] ?? "");
const delivered =
	scenario !== "plugin-absent" && scenario !== "no-sealed-entry";

// An agent child never inherits the store passphrase, nor this fake's own knobs
// (FAKE_OPENSESAME_STORE_TOKEN stands for the sealed token: only the "upstream"
// ever sees it).
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.OPENSESAME_STORE_PASSWORD;
for (const key of Object.keys(env)) {
	if (key.startsWith("FAKE_OPENSESAME_")) delete env[key];
}
for (const name of names) {
	env[name] = delivered
		? `osr_${randomBytes(16).toString("hex")}`
		: `ostest_${randomBytes(8).toString("hex")}`;
}
if (delivered) {
	env.HTTPS_PROXY = "http://opensesame:run-secret@127.0.0.1:9";
	env.SSL_CERT_FILE = "/nonexistent/run-ca.pem";
}
if (scenario === "plugin-absent") say("plugin-absent");
if (scenario === "no-sealed-entry") say("no-sealed-entry");

// How the real tool ends a run it is signalled about (apps/cli/src/dev_supervise.rs):
// SIGTERM and SIGHUP revoke the run, stop the child, say so and exit 143 or 129.
// An interrupt (SIGINT, SIGQUIT) does not stop the child, so here it is only noted.
// FAKE_OPENSESAME_SIGNALS names a file that gets one line per signal received.
// The handlers are installed BEFORE the command is started, as the real tool does: a
// signal that arrives once the command is up (a caller waiting for the command to say so
// is exactly that) must find them, and a stand-in that listens afterwards is killed by the
// default action of whatever it is sent if it is slow to get there.
let child: ChildProcess | undefined;
let ending: SampleScenario | undefined;
function note(signal: string): void {
	const file = process.env.FAKE_OPENSESAME_SIGNALS;
	if (file !== undefined) appendFileSync(file, `${signal}\n`);
}
for (const [signal, line] of [
	["SIGTERM", "sigterm"],
	["SIGHUP", "sighup"],
] as const) {
	process.on(signal, () => {
		note(signal);
		ending = line;
		child?.kill("SIGTERM");
	});
}
for (const signal of ["SIGINT", "SIGQUIT"] as const) {
	process.on(signal, () => note(signal));
}

const [program, ...args] = command;
child = spawn(program ?? "", args, { env, stdio: "inherit" });
child.on("error", () => process.exit(1));

// Test seam: the stand-in does nothing, not even run its event loop, between starting the
// command and the next line until the file named by FAKE_OPENSESAME_HOLD_AFTER_SPAWN exists.
// A busy machine does the same thing for as long as it likes (the process is descheduled
// right after the command starts), and a signal that arrives then must still be heard.
const hold = process.env.FAKE_OPENSESAME_HOLD_AFTER_SPAWN;
if (hold !== undefined) {
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (let waited = 0; !existsSync(hold) && waited < 60_000; waited += 10) {
		Atomics.wait(pause, 0, 0, 10);
	}
}

child.on("close", (code) => {
	const finish = ending ?? scenario;
	if (finish === "misdirected") {
		say("misdirected");
		process.exit(77);
	}
	if (finish === "sigterm") {
		say("sigterm");
		process.exit(143);
	}
	if (finish === "sighup") {
		say("sighup");
		process.exit(129);
	}
	process.exit(code ?? 1);
});
