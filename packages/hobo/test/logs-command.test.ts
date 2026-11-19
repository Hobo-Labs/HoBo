import { execFileSync } from "node:child_process";
import {
	appendFile,
	mkdir,
	mkdtemp,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import { afterEach, expect, it, vi } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import {
	createLocalDeploymentDownCommand,
	startLocalDeployment,
} from "../src/local-deployment.js";
import { localDeploymentLogPath } from "../src/local-deployment-log.js";
import {
	localLogResourcesPath,
	localResourceLogPath,
} from "../src/local-resource-logs.js";
import { createLogsCommand } from "../src/logs-command.js";

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryProject() {
	const project = await mkdtemp(join(tmpdir(), "hobo-logs-"));
	directories.push(project);
	await mkdir(join(project, "src"));
	await writeFile(
		join(project, "package.json"),
		JSON.stringify({ type: "module" }),
	);
	return project;
}

function cli() {
	return createHoboCli({
		commands: {
			logs: createLogsCommand(),
			down: createLocalDeploymentDownCommand(),
		},
	});
}

it("reports no log history without starting a demo deployment", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	const result = await cli().run(["logs", "--json"], { cwd: project });
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("");
});

it("returns the most recent real log lines for the selected project", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	await mkdir(join(project, ".hobo"));
	await writeFile(
		localDeploymentLogPath(project),
		`${Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n")}\n`,
	);
	const result = await cli().run(["logs", "--json"], { cwd: project });
	const records = result.stdout
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(result.exitCode).toBe(0);
	expect(records).toHaveLength(200);
	expect(records[0]).toEqual({ type: "log", message: "line-5" });
	expect(records.at(-1)).toEqual({ type: "log", message: "line-204" });
});

it("accepts a line limit and rejects invalid streaming options", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	await mkdir(join(project, ".hobo"));
	await writeFile(localDeploymentLogPath(project), "one\ntwo\nthree\n");
	const shell = cli();
	const text = await shell.run(["logs", "--lines", "2"], { cwd: project });
	expect(text.stdout).toBe("two\nthree\n");
	const tail = await shell.run(["logs", "--tail", "2"], { cwd: project });
	expect(tail.stdout).toBe("two\nthree\n");
	const json = await shell.run(["logs", "--json", "--lines=1"], {
		cwd: project,
	});
	expect(JSON.parse(json.stdout)).toEqual({ type: "log", message: "three" });
	for (const args of [
		["--lines=0"],
		["--lines=10001"],
		["--lines=2", "--tail=1"],
		["--tail=0"],
		["--follow", "-q"],
		["extra"],
	]) {
		const result = await shell.run(["logs", ...args], { cwd: project });
		expect(result.exitCode).toBe(2);
	}
});

it("follows only the requested resource", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	await mkdir(join(project, ".hobo", "resource-logs"), { recursive: true });
	await writeFile(
		localLogResourcesPath(project),
		JSON.stringify({ names: ["api", "web"] }),
	);
	await writeFile(localResourceLogPath(project, "api"), "api-first\n");
	await writeFile(localResourceLogPath(project, "web"), "web-first\n");
	const controller = new AbortController();
	const seen: string[] = [];
	let initialSeen = () => {};
	const initialReady = new Promise<void>((resolve) => {
		initialSeen = resolve;
	});
	const shell = createHoboCli({
		commands: {
			logs: createLogsCommand({
				signal: controller.signal,
				pollIntervalMs: 10,
			}),
		},
	});
	const running = shell.run(["logs", "api", "--follow", "--json"], {
		cwd: project,
		onProgress: (line) => {
			seen.push(line);
			const record = JSON.parse(line);
			if (record.message === "api-first") initialSeen();
			if (record.message === "api-second") controller.abort();
		},
	});
	try {
		await initialReady;
		await appendFile(localResourceLogPath(project, "web"), "web-second\n");
		await appendFile(localResourceLogPath(project, "api"), "api-second\n");
		expect((await running).exitCode).toBe(0);
		expect(seen.map((line) => JSON.parse(line))).toEqual([
			{ type: "log", resource: "api", message: "api-first" },
			{ type: "log", resource: "api", message: "api-second" },
		]);
	} finally {
		controller.abort();
		await running;
	}
}, 10_000);

it("follows complete lines across UTF-8 fragments and log rotation", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	await mkdir(join(project, ".hobo"));
	const logPath = localDeploymentLogPath(project);
	await writeFile(logPath, "initial\npar");
	const controller = new AbortController();
	const seen: string[] = [];
	let initialSeen = () => {};
	let partialSeen = () => {};
	const initialReady = new Promise<void>((resolve) => {
		initialSeen = resolve;
	});
	const partialReady = new Promise<void>((resolve) => {
		partialSeen = resolve;
	});
	const shell = createHoboCli({
		commands: {
			logs: createLogsCommand({
				signal: controller.signal,
				pollIntervalMs: 10,
			}),
		},
	});
	const running = shell.run(["logs", "--follow"], {
		cwd: project,
		onProgress: (line) => {
			seen.push(line);
			if (line === "initial") initialSeen();
			if (line === "partial 😀") partialSeen();
			if (line === "after rotation") controller.abort();
		},
	});
	try {
		await initialReady;
		const suffix = Buffer.from("tial 😀\n");
		await appendFile(logPath, suffix.subarray(0, 7));
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		await appendFile(logPath, suffix.subarray(7));
		await partialReady;
		await rename(logPath, `${logPath}.1`);
		await writeFile(logPath, "after rotation\n");
		const result = await running;
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(seen).toEqual([
			"initial",
			"partial 😀",
			"[log gap possible: source rotated]",
			"after rotation",
		]);
	} finally {
		controller.abort();
		await running;
	}
}, 10_000);

it("streams JSON lines and reports truncation without a closing envelope", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	await mkdir(join(project, ".hobo"));
	const logPath = localDeploymentLogPath(project);
	await writeFile(logPath, "first\n");
	const controller = new AbortController();
	const seen: string[] = [];
	let initialSeen = () => {};
	let gapSeen = () => {};
	const initialReady = new Promise<void>((resolve) => {
		initialSeen = resolve;
	});
	const gapReady = new Promise<void>((resolve) => {
		gapSeen = resolve;
	});
	const shell = createHoboCli({
		commands: {
			logs: createLogsCommand({
				signal: controller.signal,
				pollIntervalMs: 10,
			}),
		},
	});
	const running = shell.run(["logs", "--follow", "--json", "--tail=1"], {
		cwd: project,
		onProgress: (line) => {
			seen.push(line);
			const record = JSON.parse(line);
			if (record.message === "first") initialSeen();
			if (record.type === "gap") gapSeen();
			if (record.message === "second") controller.abort();
		},
	});
	try {
		await initialReady;
		await writeFile(logPath, "");
		await gapReady;
		await appendFile(logPath, "\nsecond\n");
		const result = await running;
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(seen.map((line) => JSON.parse(line))).toEqual([
			{ type: "log", message: "first" },
			{ type: "gap", reason: "truncated" },
			{ type: "log", message: "" },
			{ type: "log", message: "second" },
		]);
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/composition.cue", import.meta.url),
		);
		for (const [index, line] of seen.entries()) {
			const path = join(project, `record-${index}.json`);
			await writeFile(path, line);
			execFileSync(cue, ["vet", schema, path, "-d", "#LocalLogRecord"]);
		}
	} finally {
		controller.abort();
		await running;
	}
}, 10_000);

it("reads the running deployment's application output and component events", async () => {
	const project = await temporaryProject();
	const hoboHome = join(project, "home");
	const bindles = fileURLToPath(
		new URL("../../bindles/dist/index.js", import.meta.url),
	);
	await writeFile(
		join(project, "src/bindle.mjs"),
		`import { bindle } from ${JSON.stringify(bindles)};
export default bindle("logs-app", b => {
  const api = b.api(() => request => {
    console.error("actual-api-request", new URL(request.url).pathname);
    return new Response("api");
  });
  const web = b.web(() => async request => {
    console.log("actual-app-request", new URL(request.url).pathname);
    await fetch(process.env.services__api__http__0 + "/real-api");
    return new Response("actual app");
  }).dependsOn(api);
  return { web, api };
});
`,
	);
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_PORTLESS", "0");
	const shell = cli();
	let started = false;
	try {
		const deployment = await startLocalDeployment({
			projectDir: project,
			hoboHome,
			componentHost: "local",
			campId: "logs-camp",
			providerId: "bare-metal",
			brokerId: "local",
			bindleName: "logs-app",
			port: 0,
			ttlSeconds: 0,
		});
		started = true;
		const response = await fetch(
			`${deployment.receipt.primaryUrl.replace(/\/$/u, "")}/real-activity`,
		);
		expect(await response.text()).toBe("actual app");
		const result = await shell.run(["logs", "--json"], { cwd: project });
		const records = result.stdout
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(result.exitCode).toBe(0);
		expect(records.map((record) => record.message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("actual-app-request /real-activity"),
				expect.stringContaining('"type":"component.Invoked"'),
			]),
		);
		const web = await shell.run(["logs", "web", "--json"], { cwd: project });
		const api = await shell.run(["logs", "api", "--json"], { cwd: project });
		const webRecords = web.stdout
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const apiRecords = api.stdout
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(webRecords).toContainEqual({
			type: "log",
			resource: "web",
			message: "actual-app-request /real-activity",
		});
		expect(apiRecords).toContainEqual({
			type: "log",
			resource: "api",
			message: "actual-api-request /real-api",
		});
		expect(
			webRecords.some((record) =>
				record.message.includes("actual-api-request"),
			),
		).toBe(false);
		expect(
			apiRecords.some((record) =>
				record.message.includes("actual-app-request"),
			),
		).toBe(false);
		const missing = await shell.run(["logs", "missing", "--json"], {
			cwd: project,
		});
		expect(missing.exitCode).toBe(2);
		expect(JSON.parse(missing.stdout).message).toContain(
			"Unknown local log resource",
		);
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/composition.cue", import.meta.url),
		);
		const recordFile = join(project, "resource-record.json");
		await writeFile(
			recordFile,
			JSON.stringify(
				apiRecords.find((record) =>
					record.message.includes("actual-api-request"),
				),
			),
		);
		execFileSync(cue, ["vet", schema, recordFile, "-d", "#LocalLogRecord"]);
		execFileSync(cue, [
			"vet",
			schema,
			localLogResourcesPath(project),
			"-d",
			"#LocalLogResources",
		]);
	} finally {
		if (started) {
			const down = await shell.run(["down", "--json"], { cwd: project });
			expect(down.exitCode).toBe(0);
		}
	}
}, 90_000);
