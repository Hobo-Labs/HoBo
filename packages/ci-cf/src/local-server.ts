import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicText } from "./local-preparation.js";

const directory = process.argv[2];
if (!directory) throw new Error("missing runtime preparation");
// This durable ownership record is written before any native process starts.
await atomicText(join(directory, "server.pid"), String(process.pid));
const child = spawn(
	process.execPath,
	[
		fileURLToPath(
			new URL("../bin/wrangler.js", import.meta.resolve("wrangler")),
		),
		"dev",
		"--local",
		"--ip",
		"127.0.0.1",
		"--inspector-port",
		"0",
		"--persist-to",
		join(directory, "state"),
		"--config",
		join(directory, "wrangler.jsonc"),
	],
	{ cwd: directory, env: process.env, stdio: "inherit" },
);
child.once("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => child.kill(signal));
