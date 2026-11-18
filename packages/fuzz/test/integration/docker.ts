import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerCampaign } from "../../src/docker-campaign.js";

const result = await runDockerCampaign();
assert.equal(result.restler.coverage, "4 / 4");
assert.equal(result.restler.valid, "4 / 4");
assert.ok((result.restler.requests.main_driver ?? 0) > 0);
assert.deepEqual(result.restler.bugs, {});

const directory = await mkdtemp(join(tmpdir(), "hobo-fuzz-cleanup-test-"));
const worker = fileURLToPath(
	new URL("../../src/docker-worker.ts", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../../contracts/openapi/control-sim.v1.json", import.meta.url),
);
const probe = fileURLToPath(
	new URL("../../contracts/faults/probe.py", import.meta.url),
);
const registry = fileURLToPath(
	new URL("../../contracts/faults/registry.py", import.meta.url),
);
const env = {
	PATH: process.env.PATH ?? "",
	LANG: "C.UTF-8",
	DOCKER_HOST: "unix:///var/run/docker.sock",
	DOCKER_CONFIG: directory,
	TESTCONTAINERS_RYUK_DISABLED: "true",
};
const networkPattern = /fuzz network (hobo-fuzz-[a-f0-9-]+)/u;
function networkExists(name: string): boolean {
	return (
		spawnSync(
			"docker",
			["--host", "unix:///var/run/docker.sock", "network", "inspect", name],
			{ env, stdio: "ignore" },
		).status === 0
	);
}

function remainingContainers(name: string): string {
	const result = spawnSync(
		"docker",
		[
			"--host",
			"unix:///var/run/docker.sock",
			"ps",
			"--all",
			"--quiet",
			"--filter",
			`label=io.hobo.fuzz.run=${name}`,
		],
		{ env, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

try {
	const missing = join(directory, "missing-target.mjs");
	const failed = spawnSync(
		process.execPath,
		["--import", "tsx", worker, missing, schema, probe, registry],
		{ cwd: dirname(worker), env, encoding: "utf8", timeout: 90_000 },
	);
	assert.notEqual(failed.status, 0);
	assert.match(failed.stderr, /target ready/u);
	const failedNetwork = failed.stderr.match(networkPattern)?.[1];
	assert.ok(failedNetwork);
	assert.equal(networkExists(failedNetwork), false);
	assert.equal(remainingContainers(failedNetwork), "");

	const target = join(directory, "target.mjs");
	await writeFile(
		target,
		'import { createServer } from "node:http"; createServer((_request, response) => response.end("ok")).listen(8080, "0.0.0.0", () => process.stdout.write("target ready\\n"));',
	);
	const child = spawn(
		process.execPath,
		["--import", "tsx", worker, target, schema, probe, registry],
		{ cwd: dirname(worker), env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdout.resume();
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	let interruptedNetwork: string | undefined;
	try {
		const deadline = Date.now() + 30_000;
		while (
			!interruptedNetwork &&
			Date.now() < deadline &&
			child.exitCode === null
		) {
			interruptedNetwork = stderr.match(networkPattern)?.[1];
			if (!interruptedNetwork)
				await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(interruptedNetwork, stderr);
		child.kill("SIGTERM");
		assert.notEqual(await closed, 0);
		assert.equal(networkExists(interruptedNetwork), false);
		assert.equal(remainingContainers(interruptedNetwork), "");
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await closed;
		}
		clearTimeout(timer);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(result) + "\n");
