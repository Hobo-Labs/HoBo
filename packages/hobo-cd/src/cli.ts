#!/usr/bin/env node
import { spawn } from "node:child_process";

import { cdProjectDir } from "./project.js";

const args = process.argv.slice(2);
const lifecycle = new Set(["up", "down", "plan", "status"]);
const forwarded =
	args[0] !== undefined && lifecycle.has(args[0]) && !args.includes("--project")
		? ["cd", ...args, "--project", cdProjectDir()]
		: ["cd", ...args];
const child = spawn(process.env.HOBO_BIN || "hobo", forwarded, {
	stdio: "inherit",
});
child.on("error", () => {
	process.stderr.write(
		"hobo-cd: the hobo CLI is not on PATH (npm i -g @hobo/hobo, or set HOBO_BIN).\n",
	);
	process.exitCode = 127;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
