import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { executePipeline, parsePipeline } from "@hobo/ci/execution";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import config from "../examples/ci.json" with { type: "json" };
import {
	createAdoBackend,
	loadAdoProject,
	parseAdoProject,
	renderAzurePipeline,
	runAdoPipeline,
} from "../src/index.js";

function stopProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
			throw error;
	}
}

const dirs: string[] = [];
async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "hobo-ado-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
const plan = (script: string, artifactPaths: string[] = []) =>
	parsePipeline(
		JSON.stringify({
			id: "check",
			accountId: "local",
			timeoutSeconds: 5,
			steps: [{ id: "test", argv: [process.execPath, "-e", script] }],
			artifactPaths,
		}),
	);

describe("ADO project boundary", () => {
	it("parses immutable generated contracts", () => {
		const project = parseAdoProject(JSON.stringify(config));
		expect(project.pool).toBe("hobo-local");
		expect(
			parseAdoProject(
				JSON.stringify({ ...config, pipelinePath: ".hobo/pipeline.json" }),
			).pipelinePath,
		).toBe(".hobo/pipeline.json");
		expect(Object.isFrozen(project)).toBe(true);
		expect(Object.isFrozen(project.demands)).toBe(true);
	});
	it.each([
		{ pool: "Azure Pipelines" },
		{ pool: "azure pipelines" },
		{ pool: "Azure Pipelines " },
		{ vmImage: "ubuntu-latest" },
		{ pipelinePath: "../checks.json" },
		{ pipelinePath: "/checks.json" },
		{ pipelinePath: "$(Build.SourceDirectory)/checks.json" },
		{ demands: ["Agent.OS -equals Windows"] },
		{ demands: ["node", "node"] },
		{ artifactPrefix: "bad/name" },
		{ schemaVersion: "v2" },
	])("rejects unsafe or unsupported config %j", (fields) => {
		expect(() =>
			parseAdoProject(JSON.stringify({ ...config, ...fields })),
		).toThrow();
	});
	it("refuses source configuration symlinks outside the workspace", async () => {
		const dir = await workspace();
		const other = await workspace();
		await writeFile(join(other, "config.json"), JSON.stringify(config));
		await symlink(join(other, "config.json"), join(dir, "config.json"));
		await expect(loadAdoProject(dir, "config.json")).rejects.toThrow(
			/escapes workspace/,
		);
	});
	it("loads relative paths against the workspace and rejects Azure artifact expressions", async () => {
		const dir = await workspace();
		await writeFile(
			join(dir, "ci.json"),
			JSON.stringify({ ...config, pipelinePath: "pipeline.json" }),
		);
		await writeFile(
			join(dir, "pipeline.json"),
			JSON.stringify({
				id: "check",
				accountId: "local",
				timeoutSeconds: 5,
				steps: [{ id: "test", argv: ["node", "--version"] }],
				artifactPaths: ["$(secret)"],
			}),
		);
		await expect(loadAdoProject(dir, "ci.json")).rejects.toThrow(/literal/);
	});
});

describe("local ADO command runtime", () => {
	it("executes actual commands, preserves bytes and isolates ambient credentials", async () => {
		const dir = await workspace();
		const previous = process.env.SYSTEM_ACCESSTOKEN;
		process.env.SYSTEM_ACCESSTOKEN = "not-a-step-secret";
		try {
			const pipeline = plan(
				'if (process.env.SYSTEM_ACCESSTOKEN) process.exit(2); require("node:fs").writeFileSync("result.bin", Buffer.from([0,255,3])); process.stdout.write("ok")',
				["result.bin"],
			);
			const first = await runAdoPipeline(dir, pipeline);
			const second = await runAdoPipeline(dir, pipeline);
			expect(first.status).toBe("succeeded");
			expect(first.backend).toBe("ado");
			expect(first.steps[0]?.stdout).toBe("ok");
			expect([...(first.artifacts[0]?.data ?? [])]).toEqual([0, 255, 3]);
			expect(first.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(first.id).not.toBe(second.id);
		} finally {
			if (previous === undefined) delete process.env.SYSTEM_ACCESSTOKEN;
			else process.env.SYSTEM_ACCESSTOKEN = previous;
		}
	});
	it("preserves failure and never executes dependent commands", async () => {
		const dir = await workspace();
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "failure",
				accountId: "local",
				timeoutSeconds: 5,
				steps: [
					{ id: "fail", argv: [process.execPath, "-e", "process.exit(7)"] },
					{
						id: "never",
						argv: [
							process.execPath,
							"-e",
							'require("node:fs").writeFileSync("bad", "bad")',
						],
					},
				],
			}),
		);
		const result = await runAdoPipeline(dir, pipeline);
		expect(result.status).toBe("failed");
		expect(result.steps.map((step) => step.exitCode)).toEqual([7]);
		await expect(readFile(join(dir, "bad"))).rejects.toThrow();
	});
	it("confirms cancellation before releasing the workspace", async () => {
		const dir = await workspace();
		const stop = new AbortController();
		const timer = setTimeout(() => stop.abort(), 100);
		try {
			const result = await executePipeline(
				createAdoBackend({ workspace: dir }),
				plan("setInterval(() => {}, 1000)"),
				{ signal: stop.signal },
			);
			expect(result.status).toBe("cancelled");
		} finally {
			clearTimeout(timer);
		}
	});
	it("handles repeated cancellation signals until command cleanup finishes", async () => {
		const dir = await workspace();
		const cli = resolve(import.meta.dirname, "../dist/cli.js");
		await writeFile(
			join(dir, "ci.json"),
			JSON.stringify({ ...config, pipelinePath: "pipeline.json" }),
		);
		await writeFile(
			join(dir, "pipeline.json"),
			JSON.stringify({
				id: "cancel",
				accountId: "local",
				timeoutSeconds: 10,
				steps: [
					{
						id: "wait",
						argv: [
							process.execPath,
							"-e",
							'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000)',
						],
					},
				],
			}),
		);
		const child = spawn(process.execPath, [cli, "run", "ci.json", dir], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output: Buffer[] = [];
		child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
		const closed = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolveClose, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolveClose({ code, signal }));
		});
		let commandPid: number | undefined;
		try {
			const deadline = Date.now() + 3000;
			while (commandPid === undefined) {
				try {
					commandPid = Number(await readFile(join(dir, "ready"), "utf8"));
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ENOENT"
						)
					)
						throw error;
					if (Date.now() > deadline) throw new Error("command did not start");
					await delay(10);
				}
			}
			child.kill("SIGTERM");
			await delay(30);
			child.kill("SIGTERM");
			expect(await closed).toEqual({ code: 1, signal: null });
			expect(Buffer.concat(output).toString("utf8")).toContain(
				"HoBo CI: cancelled",
			);
			const stoppedPid = commandPid;
			expect(() => process.kill(stoppedPid, 0)).toThrow(/ESRCH/);
		} finally {
			child.kill("SIGKILL");
			if (commandPid !== undefined) stopProcessGroup(commandPid);
			await closed;
		}
	});
	it("uses the actual CLI for local success and failure", async () => {
		const dir = await workspace();
		const cli = resolve(import.meta.dirname, "../dist/cli.js");
		await writeFile(
			join(dir, "ci.json"),
			JSON.stringify({ ...config, pipelinePath: "pipeline.json" }),
		);
		await writeFile(
			join(dir, "pipeline.json"),
			JSON.stringify({
				id: "cli",
				accountId: "local",
				timeoutSeconds: 5,
				steps: [
					{
						id: "check",
						argv: [
							process.execPath,
							"-e",
							'console.log("##vso[task.complete result=Succeeded;]fake")',
						],
					},
				],
			}),
		);
		const result = await promisify(execFile)(process.execPath, [
			cli,
			"run",
			"ci.json",
			dir,
		]);
		expect(result.stdout).toContain("HoBo CI: succeeded");
		expect(result.stdout).toContain("##vso%5B");
		expect(result.stdout).not.toMatch(/##vso\[/i);
		await writeFile(
			join(dir, "pipeline.json"),
			JSON.stringify({
				id: "cli",
				accountId: "local",
				timeoutSeconds: 5,
				steps: [
					{ id: "check", argv: [process.execPath, "-e", "process.exit(4)"] },
				],
			}),
		);
		await expect(
			promisify(execFile)(process.execPath, [cli, "run", "ci.json", dir]),
		).rejects.toMatchObject({ code: 1 });
	});
});

it("renders the approved self-hosted pipeline and artifact task configuration", async () => {
	const { project, pipeline } = await loadAdoProject(
		resolve(import.meta.dirname, "../../.."),
		"packages/ci-ado/examples/ci.json",
	);
	const yaml = renderAzurePipeline(
		project,
		pipeline,
		"packages/ci-ado/examples/ci.json",
	);
	await expect(yaml).toMatchFileSnapshot("__snapshots__/azure-pipelines.yml");
	expect(yaml).toBe(
		await readFile(
			new URL("../examples/azure-pipelines.yml", import.meta.url),
			"utf8",
		),
	);
	const document = parse(yaml);
	expect(document.jobs[0].pool).toEqual({
		name: "hobo-local",
		demands: ["Agent.OS -equals Linux"],
	});
	expect(document.jobs[0].steps.at(-1)).toMatchObject({
		task: "PublishPipelineArtifact@1",
		condition:
			"and(succeededOrFailed(), eq(variables['HOBO_CI_BUNDLE_READY'], 'true'))",
		inputs: {
			targetPath:
				"$(Agent.TempDirectory)/hobo-ci-$(System.JobId)-$(System.JobAttempt)",
			artifact: "hobo-$(System.JobId)-$(System.JobAttempt)",
		},
	});
	expect(yaml).not.toContain("vmImage");
	expect(document.trigger).toBe("none");
});
