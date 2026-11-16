#!/usr/bin/env node
import { spawn } from "node:child_process";

import { ciProjectDir } from "./project.js";

// `hobo-ci up|down|plan|status`: this project's own CLI. It is the same
// lifecycle as `hobo ci <action> --project <this package>`, run by the `hobo`
// binary on PATH, so the CI project is converged by the one HoBo engine and
// never by a second one. Any other subcommand is passed to `hobo ci`.
const args = process.argv.slice(2);
const lifecycle = new Set(["up", "down", "plan", "status"]);
const forwarded =
	args[0] !== undefined && lifecycle.has(args[0]) && !args.includes("--project")
		? ["ci", ...args, "--project", ciProjectDir()]
		: ["ci", ...args];
const child = spawn(process.env.HOBO_BIN || "hobo", forwarded, {
	stdio: "inherit",
});
child.on("error", () => {
	process.stderr.write(
		"hobo-ci: the hobo CLI is not on PATH (npm i -g @hobo/hobo, or set HOBO_BIN).\n",
	);
	process.exitCode = 127;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
