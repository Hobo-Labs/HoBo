// A process that runs the adapter, so a test can signal a real one.
//
//   node --import tsx run-adapter.mts <opensesame> <out dir>
//
// The command it runs writes <out dir>/child.pid and then waits. The names in
// RUNNER_PASS_ENV (comma separated) are passed on as `passEnv`. It prints
// `OUTCOME <json>` and exits 0 when the run returns, `THREW <code>` and exits 9
// when it throws. An interrupt re-raised by the adapter ends it by that signal.
import { parseCredentialBindings } from "../../src/binding.js";
import { OpenSesameAdapterError } from "../../src/errors.js";
import { runProxied } from "../../src/launch.js";

const [bin, out] = process.argv.slice(2);
if (bin === undefined || out === undefined) {
	throw new Error("usage: run-adapter.mts <opensesame> <out dir>");
}

const bindings = parseCredentialBindings({
	bindings: [
		{
			locator: "hobo-token://vercel/deploy",
			connection: "conn://acme/vercel",
			provider: "vercel",
			env_name: "VERCEL_TOKEN",
			paths: ["/v9/projects"],
			methods: ["GET"],
			projection: "legacy-token",
		},
	],
});

try {
	const outcome = await runProxied({
		bin,
		bindings,
		argv: [
			process.execPath,
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(`${out}/child.pid`)}, String(process.pid)); setInterval(() => {}, 1000)`,
		],
		passEnv: (process.env.RUNNER_PASS_ENV ?? "").split(",").filter(Boolean),
	});
	process.stdout.write(`OUTCOME ${JSON.stringify(outcome)}\n`);
	process.exit(0);
} catch (error) {
	const code = error instanceof OpenSesameAdapterError ? error.code : "other";
	process.stdout.write(`THREW ${code} ${String(error)}\n`);
	process.exit(9);
}
