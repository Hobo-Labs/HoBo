import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSchemathesis } from "../../src/schemathesis.js";

const result = await runSchemathesis({ seconds: 20, seed: 1742 });
assert.equal(result.ran, true, result.reason);
assert.equal(result.passed, true, result.reason);
assert.equal(result.status, 0, result.reason);
assert.ok((result.requests ?? 0) >= 20);
assert.deepEqual(result.operations, [
	"applyBindle",
	"createBindle",
	"destroyBindle",
	"listResources",
]);
const cli = fileURLToPath(new URL("../../src/nightly-cli.ts", import.meta.url));
const child = spawnSync(
	process.execPath,
	[
		"--import",
		"tsx",
		cli,
		"--runs",
		"1",
		"--seed",
		"1742",
		"--api",
		"--no-docker",
	],
	{
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
		timeout: 60_000,
	},
);
assert.equal(child.status, 0, child.stderr);
const cliResult = JSON.parse(child.stdout);
assert.equal(cliResult.api.ran, true);
assert.equal(cliResult.api.passed, true);
assert.ok(cliResult.api.requests >= 20);
process.stdout.write(
	JSON.stringify({ direct: result, cli: cliResult.api }) + "\n",
);
