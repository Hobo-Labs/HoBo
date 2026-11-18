import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { JsonValue } from "@hobo/core";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { assertLocalSchema } from "./schemathesis.js";
import type { FuzzValue } from "./manifest.js";

import { DOCKER_IMAGES } from "./docker-images.js";

const {
	DATABASE_IMAGE,
	DEPENDENCY_IMAGES,
	NODE_IMAGE,
	QUEUE_IMAGE,
	REGISTRY_IMAGE,
	RESTLER_IMAGE,
	TOXIPROXY_IMAGE,
} = DOCKER_IMAGES;

const network = `hobo-fuzz-${randomUUID()}`;
const containers: StartedTestContainer[] = [];
let createdNetwork = false;
let cleanupPromise: Promise<void> | undefined;
let activeStart: Promise<StartedTestContainer> | undefined;
let shuttingDown = false;

function docker(...args: string[]): string {
	return execFileSync(
		"docker",
		["--host", "unix:///var/run/docker.sock", ...args],
		{
			encoding: "utf8",
			timeout: 30_000,
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

async function cleanup(): Promise<void> {
	if (!cleanupPromise) {
		cleanupPromise = (async () => {
			const failures: unknown[] = [];
			for (const container of containers.reverse()) {
				try {
					await container.stop({
						timeout: 10_000,
						remove: true,
						removeVolumes: true,
					});
				} catch (error) {
					failures.push(error);
				}
			}
			if (createdNetwork) {
				try {
					const ids = docker(
						"ps",
						"--all",
						"--quiet",
						"--filter",
						`label=io.hobo.fuzz.run=${network}`,
					)
						.split(/\s+/u)
						.filter(Boolean);
					if (ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id)))
						throw new Error("invalid disposable container id");
					if (ids.length > 0) docker("rm", "--force", ...ids);
				} catch (error) {
					failures.push(error);
				}
				try {
					docker("network", "rm", network);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length)
				throw new Error("failed to remove disposable fuzz infrastructure");
		})();
	}
	return cleanupPromise;
}

async function start(
	container: GenericContainer,
): Promise<StartedTestContainer> {
	if (shuttingDown) throw new Error("campaign interrupted");
	const pending = container.withLabels({ "io.hobo.fuzz.run": network }).start();
	activeStart = pending;
	try {
		const started = await pending;
		containers.push(started);
		if (shuttingDown) throw new Error("campaign interrupted");
		return started;
	} finally {
		activeStart = undefined;
	}
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		shuttingDown = true;
		void (async () => {
			try {
				await activeStart;
			} catch {}
			await cleanup();
		})().finally(() => process.exit(1));
	});
}

async function execute(
	container: StartedTestContainer,
	command: string[],
	workingDir?: string,
) {
	const result = await container.exec(
		command,
		workingDir ? { workingDir } : {},
	);
	if (result.exitCode !== 0)
		throw new Error(
			`campaign command failed (${result.exitCode}): ${result.output.slice(-4000)}`,
		);
	return result.stdout;
}

async function main(): Promise<void> {
	const [targetPath, schemaPath, probePath, registryProbePath] =
		process.argv.slice(2);
	if (!targetPath || !schemaPath || !probePath || !registryProbePath)
		throw new Error("missing campaign inputs");
	const spec = await readFile(schemaPath, "utf8");
	if (Buffer.byteLength(spec) > 1_000_000)
		throw new Error("schema exceeds the size limit");
	const document: FuzzValue = JSON.parse(spec);
	assertLocalSchema(document);
	for (const image of [...DEPENDENCY_IMAGES, RESTLER_IMAGE])
		docker("image", "inspect", image, "--format", "{{.Id}}");
	docker("network", "create", "--internal", network);
	createdNetwork = true;
	process.stderr.write(`fuzz network ${network}\n`);
	await start(
		new GenericContainer(NODE_IMAGE)
			.withNetworkMode(network)
			.withNetworkAliases("target")
			.withCopyFilesToContainer([{ source: targetPath, target: "/target.mjs" }])
			.withCommand(["node", "/target.mjs"])
			.withWaitStrategy(Wait.forLogMessage("target ready"))
			.withStartupTimeout(60_000),
	);
	const proxy = await start(
		new GenericContainer(TOXIPROXY_IMAGE)
			.withNetworkMode(network)
			.withNetworkAliases("proxy")
			.withWaitStrategy(Wait.forLogMessage("Starting Toxiproxy HTTP server"))
			.withStartupTimeout(60_000),
	);
	const database = await start(
		new GenericContainer(DATABASE_IMAGE)
			.withNetworkMode(network)
			.withNetworkAliases("database")
			.withEnvironment({
				POSTGRES_USER: "hobo",
				POSTGRES_DB: "hobo",
				POSTGRES_PASSWORD: "fixture-only",
			})
			.withWaitStrategy(
				Wait.forLogMessage("database system is ready to accept connections", 2),
			)
			.withStartupTimeout(60_000),
	);
	const queue = await start(
		new GenericContainer(QUEUE_IMAGE)
			.withNetworkMode(network)
			.withNetworkAliases("queue")
			.withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
			.withStartupTimeout(60_000),
	);
	await start(
		new GenericContainer(REGISTRY_IMAGE)
			.withNetworkMode(network)
			.withNetworkAliases("registry")
			.withWaitStrategy(Wait.forLogMessage("listening on"))
			.withStartupTimeout(60_000),
	);
	const driver = await start(
		new GenericContainer(RESTLER_IMAGE)
			.withNetworkMode(network)
			.withCopyContentToContainer([{ content: spec, target: "/control.json" }])
			.withCopyFilesToContainer([
				{ source: probePath, target: "/probe.py" },
				{ source: registryProbePath, target: "/registry.py" },
			])
			.withEntrypoint(["/bin/sh"])
			.withCommand(["-c", "mkdir -p /work && echo driver-ready && sleep 1800"])
			.withWaitStrategy(Wait.forLogMessage("driver-ready"))
			.withStartupTimeout(60_000),
	);
	const fault = JSON.parse(
		await execute(driver, ["/venv/bin/python3", "/probe.py"]),
	);
	const admin = async (method: string, path: string, value?: JsonValue) =>
		execute(driver, [
			"/venv/bin/python3",
			"-c",
			"import requests,sys,json; r=requests.request(sys.argv[1], 'http://proxy:8474'+sys.argv[2], json=json.loads(sys.argv[3]), timeout=3); r.raise_for_status()",
			method,
			path,
			JSON.stringify(value ?? null),
		]);
	const psql = (query: string) =>
		database.exec(
			[
				"psql",
				"-h",
				"proxy",
				"-p",
				"8667",
				"-U",
				"hobo",
				"-d",
				"hobo",
				"-tAc",
				query,
			],
			{ env: { PGPASSWORD: "fixture-only" } },
		);
	const createTable = await psql("CREATE TABLE requests (id text PRIMARY KEY)");
	if (createTable.exitCode !== 0) throw new Error("database setup failed");
	await admin("POST", "/proxies/database/toxics", {
		name: "reset",
		type: "reset_peer",
		stream: "downstream",
		toxicity: 1,
		attributes: { timeout: 0 },
	});
	const interrupted = await psql(
		"INSERT INTO requests VALUES ('once') ON CONFLICT DO NOTHING",
	);
	if (interrupted.exitCode === 0)
		throw new Error("database reset did not interrupt the request");
	await admin("DELETE", "/proxies/database/toxics/reset");
	const retried = await psql(
		"INSERT INTO requests VALUES ('once') ON CONFLICT DO NOTHING; SELECT count(*) FROM requests",
	);
	if (retried.exitCode !== 0 || !/\b1\s*$/.test(retried.stdout))
		throw new Error("database retry duplicated a request");
	const enqueue = () =>
		queue.exec([
			"redis-cli",
			"-h",
			"proxy",
			"-p",
			"8668",
			"EVAL",
			"if redis.call('SETNX', KEYS[1], ARGV[1]) == 1 then redis.call('LPUSH', KEYS[2], ARGV[1]) end return redis.call('LLEN', KEYS[2])",
			"2",
			"request:once",
			"jobs",
			"fixture-job",
		]);
	await admin("POST", "/proxies/queue/toxics", {
		name: "reset",
		type: "reset_peer",
		stream: "downstream",
		toxicity: 1,
		attributes: { timeout: 0 },
	});
	const interruptedQueue = await enqueue();
	if (interruptedQueue.exitCode === 0)
		throw new Error("queue reset did not interrupt the request");
	await admin("DELETE", "/proxies/queue/toxics/reset");
	const retriedQueue = await enqueue();
	if (retriedQueue.exitCode !== 0 || retriedQueue.stdout.trim() !== "1")
		throw new Error("queue retry duplicated a job");
	const job = await queue.exec([
		"redis-cli",
		"-h",
		"proxy",
		"-p",
		"8668",
		"RPOP",
		"jobs",
	]);
	if (job.exitCode !== 0 || job.stdout.trim() !== "fixture-job")
		throw new Error("queue returned the wrong job");
	const registryResult = JSON.parse(
		await execute(driver, ["/venv/bin/python3", "/registry.py"]),
	);
	await execute(
		driver,
		[
			"/RESTler/restler/Restler",
			"--disable_log_upload",
			"compile",
			"--api_spec",
			"/control.json",
		],
		"/work",
	);
	await execute(driver, [
		"/RESTler/restler/Restler",
		"--disable_log_upload",
		"fuzz-lean",
		"--grammar_file",
		"/work/Compile/grammar.py",
		"--dictionary_file",
		"/work/Compile/dict.json",
		"--target_ip",
		proxy.getIpAddress(network),
		"--target_port",
		"8666",
		"--no_ssl",
		"--host",
		"proxy",
		"--no_results_analyzer",
	]);
	const summary = await execute(driver, [
		"/venv/bin/python3",
		"-c",
		`import glob,json\np=glob.glob('/FuzzLean/RestlerResults/experiment*/logs/testing_summary.json')\nassert len(p)==1\ns=json.load(open(p[0]))\nprint(json.dumps(s))`,
	]);
	const report = JSON.parse(summary);
	if (
		report.final_spec_coverage !== "4 / 4" ||
		report.rendered_requests_valid_status !== "4 / 4" ||
		report.num_sequence_failures !== 0 ||
		Object.keys(report.bug_buckets).length !== 0 ||
		Object.keys(report.reproducible_bug_buckets).length !== 0 ||
		report.total_requests_sent.main_driver < 1
	)
		throw new Error("RESTler found a failure or did not cover the API");
	process.stdout.write(
		JSON.stringify({
			fault,
			database: { reset: true, idempotent: true },
			queue: { reset: true, idempotent: true },
			registry: registryResult,
			restler: {
				coverage: report.final_spec_coverage,
				valid: report.rendered_requests_valid_status,
				requests: report.total_requests_sent,
				bugs: report.bug_buckets,
			},
		}) + "\n",
	);
}

try {
	await main();
} catch (error) {
	process.stderr.write(
		(error instanceof Error ? error.message : "campaign failed") + "\n",
	);
	process.exitCode = 1;
} finally {
	await cleanup();
}
