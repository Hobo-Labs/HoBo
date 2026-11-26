#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Tells the test this process is ready and holds the connection until it dies,
// so the test sees both events without polling. `then` runs once the pid is
// handed to the kernel.
function announce(then: () => void = () => {}): void {
	const probe = process.env.FIXTURE_PROBE;
	if (!probe) {
		then();
		return;
	}
	const socket = connect(probe, () => {
		socket.write(`${process.pid}\n`, then);
	});
}

// A real subprocess derived from the CLI Pact. No engine or network is started.
if (process.argv[2] === "transport-child") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 100);
	announce(() => process.send?.("ready", () => process.disconnect?.()));
} else {
	const settings = process.env.XDG_CONFIG_HOME;
	const config = process.env.DAGGER_CONFIG;
	if (!settings || !config) throw new Error("missing isolated CLI settings");
	if (process.env.FIXTURE_IGNORE_TERM) process.on("SIGTERM", () => {});
	appendFileSync(
		join(process.cwd(), "observed.jsonl"),
		`${JSON.stringify({
			argv: process.argv.slice(2),
			settings,
			savedLogin: existsSync(join(settings, "dagger", "credentials.json")),
			configText: readFileSync(config, "utf8"),
			keys: Object.keys(process.env),
			// The test passes "" for a variable the host does not set.
			proxyPreserved:
				(process.env.HTTPS_PROXY ?? "") === (process.env.FIXTURE_PROXY ?? ""),
			caPreserved:
				(process.env.NODE_EXTRA_CA_CERTS ?? "") ===
				(process.env.FIXTURE_CA ?? ""),
		})}\n`,
	);
	if (process.argv[2] === "version") {
		writeSync(
			1,
			process.env.FIXTURE_VERSION_OUTPUT ??
				`version:     v${process.env.FIXTURE_VERSION ?? "1.0.0-beta.21"}\ncommit:      fixture\nplatform:    linux/amd64\n`,
		);
	} else if (process.env.FIXTURE_CHILD) {
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				fileURLToPath(import.meta.url),
				"transport-child",
			],
			{ stdio: ["ignore", "ignore", "ignore", "ipc"] },
		);
		if (process.env.FIXTURE_CHILD_PARENT_EXIT) {
			// Exit only once the transport runs, leaving it behind as a real orphan.
			child.once("message", () => {
				child.unref();
				process.exitCode = 0;
			});
		} else {
			setInterval(() => {}, 100);
		}
	} else if (process.env.FIXTURE_WAIT) {
		setInterval(() => {}, 100);
		announce();
	} else {
		process.exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? 17);
	}
}
