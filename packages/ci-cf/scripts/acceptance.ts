import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fromJsonString } from "@bufbuild/protobuf";
import { PipelineResultSchema } from "@hobo/ci/execution";
import { LocalRunReceiptSchema } from "../src/_generated/readiness_pb.js";
import {
	CI_CF_ROOT,
	prepareLocal,
	readPreparation,
} from "../src/local-preparation.js";
import { freeLocalPort, ownedContainers } from "../src/local-runtime.js";
import { proveLocalSafety } from "./proof.js";

// Opt-in Linux/local Docker acceptance. Every pipeline uses the actual pinned
// SDK, workerd, Workflows journal, Sandbox containers, and local R2 snapshots.
// No cloud account, token, deployed resources, or network package install.
const work = process.env.HOBO_CI_ACCEPTANCE_ROOT
	? resolve(process.env.HOBO_CI_ACCEPTANCE_ROOT)
	: await mkdtemp(join(tmpdir(), "hobo-ci-cf-acceptance-"));
await mkdir(work, { recursive: true });
console.log(`Native acceptance evidence: ${work}`);
const source = join(work, "source");
await mkdir(join(source, "vendor/fixture"), { recursive: true });
const git = (...args: string[]) =>
	execFileSync("git", ["-C", source, ...args], {
		encoding: "utf8",
		env: Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
	}).trim();
await writeFile(
	join(source, "package.json"),
	JSON.stringify({
		name: "native-acceptance",
		version: "1.0.0",
		dependencies: { fixture: "file:vendor/fixture" },
	}),
);
await writeFile(
	join(source, "vendor/fixture/package.json"),
	JSON.stringify({ name: "fixture", version: "1.0.0", main: "index.js" }),
);
await writeFile(
	join(source, "vendor/fixture/index.js"),
	"module.exports='dependency-restored';\n",
);
await writeFile(join(source, "tracked.txt"), "original");
await writeFile(join(source, "obsolete.txt"), "delete-me");
await writeFile(join(source, ".gitignore"), "node_modules\n");
execFileSync(
	"npm",
	["install", "--package-lock-only", "--ignore-scripts", "--offline"],
	{ cwd: source, stdio: "ignore" },
);
git("init", "-q");
git("add", ".");
git(
	"-c",
	"user.name=Native Acceptance",
	"-c",
	"user.email=local@example.test",
	"-c",
	"commit.gpgsign=false",
	"commit",
	"-qm",
	"pinned offline dependency fixture",
);
const sourceSha = git("rev-parse", "HEAD");
// Uncommitted state must not enter any native container.
await writeFile(join(source, "tracked.txt"), "uncommitted");
await writeFile(join(source, "host-secret"), "must-not-enter-image");
const gateway = execFileSync(
	"docker",
	[
		"network",
		"inspect",
		"bridge",
		"--format",
		"{{(index .IPAM.Config 0).Gateway}}",
	],
	{ encoding: "utf8" },
).trim();
const hits = new Map<string, number>();
const fixture = createServer((req, res) => {
	const key = req.url ?? "/";
	hits.set(key, (hits.get(key) ?? 0) + 1);
	res.end("ack");
});
await new Promise<void>((done, reject) => {
	fixture.once("error", reject);
	fixture.listen(0, gateway, done);
});
const address = fixture.address();
if (!address || !(address instanceof Object))
	throw new Error("missing fixture port");
const endpoint = `http://${gateway}:${address.port}`;
const rows: string[] = [];
const executions: {
	child: ReturnType<typeof spawn>;
	done: Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		stdout: string;
		stderr: string;
	}>;
}[] = [];
const step = (id: string, script: string) => ({
	id,
	argv: ["sh", "-c", script],
	cwd: ".",
	env: {},
});
const request = (name: string) =>
	`node -e 'require("http").get(${JSON.stringify(`${endpoint}/${name}`)},r=>{r.resume();r.on("end",()=>{if(r.statusCode!==200)process.exit(1)})}).on("error",()=>process.exit(1))'`;
async function preparation(
	name: string,
	steps: ReturnType<typeof step>[],
	artifacts: string[] = [],
	timeout = 180,
): Promise<string> {
	const pipeline = join(work, `${name}.json`);
	await writeFile(
		pipeline,
		JSON.stringify({
			id: name,
			accountId: "local",
			timeoutSeconds: timeout,
			steps,
			artifactPaths: artifacts,
			requiredCapabilities: [],
		}),
	);
	return prepareLocal(source, pipeline, "HEAD", work, await freeLocalPort());
}
function launch(
	directory: string,
	resume?: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			join(CI_CF_ROOT, "scripts/local.ts"),
			"run",
			"--directory",
			directory,
			"--json",
			...(resume ? ["--resume", resume] : []),
		],
		{ cwd: CI_CF_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (data: Buffer) => {
		stdout += data.toString();
		if (stdout.length > 32 * 1024 * 1024) child.kill("SIGTERM");
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const done = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		stdout: string;
		stderr: string;
	}>((resolveDone, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			resolveDone({ code, signal, stdout, stderr }),
		);
	});
	const execution = { child, done };
	executions.push(execution);
	return execution;
}
async function receipt(
	directory: string,
	execution: ReturnType<typeof launch>,
	expected: number,
) {
	const output = await execution.done;
	assert.equal(
		output.code,
		expected,
		`${directory}: ${output.stderr}\n${output.stdout.slice(0, 1000)}`,
	);
	const result = fromJsonString(LocalRunReceiptSchema, output.stdout.trim());
	assert.equal(result.sourceSha, sourceSha);
	assert.ok(result.dockerHost.startsWith("unix://"));
	assert.ok(result.dockerId);
	assert.equal(result.state?.phase, "finished");
	assert.equal(result.state.shutdownConfirmed, true);
	assert.deepEqual(
		ownedContainers(result.preparationId),
		[],
		"native containers and interception proxies must be gone",
	);
	const disk = fromJsonString(
		LocalRunReceiptSchema,
		await readFile(join(directory, `run-${result.workflowId}.json`), "utf8"),
	);
	assert.deepEqual(result, disk);
	rows.push(
		`| ${JSON.parse((await readPreparation(directory)).pipelineJson).id} | ${result.workflowId} | ${result.state.outcome} | ${expected} | confirmed |`,
	);
	return result;
}
async function waitHit(
	name: string,
	execution: ReturnType<typeof launch>,
): Promise<void> {
	const deadline = Date.now() + 90000;
	while (!hits.get(`/${name}`)) {
		if (execution.child.exitCode !== null)
			throw new Error(`native command exited before ${name}`);
		if (Date.now() > deadline)
			throw new Error(`native command never reached ${name}`);
		await delay(100);
	}
}
try {
	const proof = proveLocalSafety();
	const success = await preparation(
		"native-success",
		[
			step(
				"artifact-0",
				`test "$(cat tracked.txt)" = original && test ! -e host-secret && ${request("build-stress")} && npm ci --offline --ignore-scripts && printf changed > tracked.txt && rm obsolete.txt`,
			),
			step(
				"verify",
				'test "$(cat tracked.txt)" = changed && test ! -e obsolete.txt && node -e \'const f=require("fs");if(require("fixture")!=="dependency-restored")process.exit(9);f.writeFileSync("binary.dat",Buffer.alloc(1048576,173));process.stdout.write("x".repeat(120000));process.stderr.write("separate-stderr")\'',
			),
		],
		["binary.dat"],
		300,
	);
	const successRun = launch(success);
	await waitHit("build-stress", successRun);
	execFileSync(
		process.execPath,
		[
			join(CI_CF_ROOT, "../../node_modules/typescript/bin/tsc"),
			"-p",
			join(CI_CF_ROOT, "../ci/tsconfig.json"),
		],
		{ stdio: "pipe" },
	);
	const succeeded = await receipt(success, successRun, 0);
	const result = fromJsonString(PipelineResultSchema, succeeded.resultJson);
	assert.equal(result.status, "succeeded");
	assert.equal(result.steps[1]?.stdout.length, 120000);
	assert.equal(result.steps[1]?.stderr, "separate-stderr");
	const artifact = result.artifacts[0];
	assert.ok(artifact);
	assert.equal(artifact.data.byteLength, 1048576);
	const digest = createHash("sha256")
		.update(Buffer.alloc(1048576, 173))
		.digest("hex");
	assert.equal(artifact.sha256, digest);
	assert.equal(
		createHash("sha256")
			.update(
				await readFile(
					join(success, `artifacts-${succeeded.workflowId}/binary.dat`),
				),
			)
			.digest("hex"),
		digest,
	);
	const log = await readFile(join(success, "runtime.log"), "utf8");
	assert.ok(log.includes("backup.restore success"));
	assert.ok(log.includes("backup.create success"));
	assert.ok(
		!log.includes("Local server updated"),
		"shared package rebuild must not hot-reload the frozen Worker",
	);
	assert.ok(
		!log.includes(
			(await readFile(join(success, "access-token"), "utf8")).trim(),
		),
		"token must not be printed",
	);
	await receipt(
		success,
		launch(success, succeeded.workflowId, {
			...process.env,
			DOCKER_CONTEXT: "nonexistent-context",
			DOCKER_HOST: "unix:///nonexistent-docker.sock",
		}),
		0,
	);
	console.log(
		"PASS native success: dependency install/restore, committed source, edit/deletion, 120KB logs, 1MiB binary chunking and SHA, cleanup and finished-receipt replay under changed Docker context",
	);
	const failure = await preparation("native-failure", [
		step("fail", "printf actual-stdout; printf actual-stderr >&2; exit 23"),
		step("must-not-run", request("forbidden")),
	]);
	const failed = await receipt(failure, launch(failure), 1);
	const failureResult = fromJsonString(PipelineResultSchema, failed.resultJson);
	assert.equal(failureResult.steps.length, 1);
	assert.equal(failureResult.steps[0]?.exitCode, 23);
	assert.equal(failureResult.steps[0]?.stdout, "actual-stdout");
	assert.equal(failureResult.steps[0]?.stderr, "actual-stderr");
	assert.equal(hits.get("/forbidden"), undefined);
	console.log(
		"PASS native failure: exit 23, both streams retained, next command not admitted",
	);
	const timeout = await preparation(
		"native-timeout",
		[step("wait", `${request("timeout")}; sleep 90`)],
		[],
		12,
	);
	await receipt(timeout, launch(timeout), 124);
	console.log("PASS native deadline: exit 124 and confirmed shutdown");
	const cancel = await preparation("native-cancel", [
		step("wait", `${request("cancel")}; sleep 90`),
	]);
	const cancelled = launch(cancel);
	await waitHit("cancel", cancelled);
	const concurrent = await launch(cancel).done;
	assert.equal(concurrent.code, 2);
	assert.ok(concurrent.stderr.includes("another controller"));
	const p = await readPreparation(cancel);
	assert.equal(
		(await fetch(`http://127.0.0.1:${p.port}/__hobo/health`)).status,
		403,
	);
	const token = (await readFile(join(cancel, "access-token"), "utf8")).trim();
	assert.equal(
		(
			await fetch(`http://127.0.0.1:${p.port}/__hobo/health`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Origin: "https://example.test",
				},
			})
		).status,
		403,
	);
	// The optional socket fast path may be absent, but mandatory interception must remain.
	const proxy = ownedContainers(p.id).find((name) => name.endsWith("-proxy"));
	assert.ok(proxy);
	const rules = execFileSync(
		"docker",
		["exec", proxy, "/usr/sbin/iptables", "-t", "mangle", "-S", "PREROUTING"],
		{ encoding: "utf8" },
	);
	assert.ok(rules.includes("TPROXY"));
	const invalidRule = spawnSync(
		"docker",
		[
			"exec",
			proxy,
			"/usr/local/sbin/iptables",
			"-t",
			"mangle",
			"-A",
			"PREROUTING",
			"-j",
			"HOBO_INVALID_TARGET",
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(
		invalidRule.status,
		0,
		"compatibility must not suppress mandatory rule errors",
	);
	cancelled.child.kill("SIGINT");
	await receipt(cancel, cancelled, 130);
	assert.equal(hits.get("/cancel"), 1);
	console.log(
		"PASS native cancellation, private local API, retained TPROXY interception, no command retry",
	);
	const crash = await preparation("native-crash", [
		step("effect", `${request("crash")}; sleep 90`),
	]);
	const interrupted = launch(crash);
	await waitHit("crash", interrupted);
	interrupted.child.kill("SIGKILL");
	const killed = await interrupted.done;
	assert.equal(killed.signal, "SIGKILL");
	const receiptFile = (await readdir(crash)).find(
		(name) => name.startsWith("run-") && name.endsWith(".json"),
	);
	assert.ok(receiptFile);
	const unsafeRestart = await launch(crash).done;
	assert.equal(unsafeRestart.code, 2);
	assert.ok(unsafeRestart.stderr.includes("requires --resume"));
	const unfinished = fromJsonString(
		LocalRunReceiptSchema,
		await readFile(join(crash, receiptFile), "utf8"),
	);
	const recovered = await receipt(
		crash,
		launch(crash, unfinished.workflowId),
		2,
	);
	assert.equal(recovered.state?.outcome, "uncertain");
	assert.equal(
		hits.get("/crash"),
		1,
		"interrupted external side effect must never be repeated",
	);
	console.log(
		"PASS native crash recovery: one externally observed side effect, no replay, uncertain outcome, confirmed cleanup",
	);
	const excess = await preparation("native-output-bound", [
		step("oversize", "node -e 'process.stdout.write(\"x\".repeat(196609))'"),
	]);
	const oversized = await receipt(excess, launch(excess), 1);
	assert.notEqual(oversized.state?.outcome, "succeeded");
	console.log("PASS native output bound rejects oversized Workflow results");
	await writeFile(
		join(work, "acceptance.md"),
		`# Native acceptance\n\nExecuted ${new Date().toISOString()} on Linux with local Docker. SDK @cloudflare/ci 0.2.0, Sandbox 0.12.1, Wrangler 4.114.0. No Cloudflare account or paid resources.\n\nComplete safety graph: ${proof.states} states / ${proof.edges} transitions.\n\nSource: ${sourceSha}. Binary artifact SHA-256: ${digest}.\n\n| Case | Native Workflow | Outcome | CLI exit | Shutdown |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nEach row has a protobuf run receipt and retained native runtime/journal/R2 evidence in its preparation directory. External bridge HTTP counters proved failure stopped later commands and crash cleanup did not repeat side effects. Mandatory TPROXY interception was inspected in the real native proxy.\n`,
	);
	console.log(
		`PASS all native acceptance cases; report ${join(work, "acceptance.md")}`,
	);
} finally {
	for (const execution of executions) {
		if (
			execution.child.exitCode === null &&
			execution.child.signalCode === null
		)
			execution.child.kill("SIGTERM");
	}
	await Promise.allSettled(executions.map((execution) => execution.done));
	await new Promise<void>((done, reject) =>
		fixture.close((error) => (error ? reject(error) : done())),
	);
}
