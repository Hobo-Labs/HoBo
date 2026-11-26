import { execFile } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	OfferSchema,
	parseConfiguration,
} from "@hobo/ci";
import { PipelineScheduler } from "@hobo/ci/scheduler";
import { LeaseStore } from "@hobo/ci/store";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import artifactPact from "../contracts/pipeline.pact.json" with {
	type: "json",
};
import { artifactReportDigest } from "../src/artifacts.js";
import {
	adoPlanDigest,
	createAdoBackend,
	loadAdoProject,
	parseAdoProject,
	renderAzurePipeline,
	runAdoPipeline,
	verifyArtifactBundle,
} from "../src/index.js";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/cli.js");
const directories: string[] = [];
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "hobo-ado-production-"));
	directories.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture(
	script = 'require("node:fs").mkdirSync("nested",{recursive:true});require("node:fs").writeFileSync("nested/result.bin",Buffer.from([0,255,7]));console.log("done")',
	refs: Record<string, string> = {},
) {
	const root = await directory();
	const config = {
		schemaVersion: "hobo.ci.ado/v1",
		pool: "hobo-local",
		pipelinePath: "pipeline.json",
		artifactPrefix: "checks",
		environmentRefs: refs,
		runnerArgv: [process.execPath, cli],
		bootstrapArgv: [process.execPath, "-e", "process.exit(0)"],
	};
	const plan = {
		id: "production-check",
		accountId: "local",
		timeoutSeconds: 5,
		steps: [{ id: "check", argv: [process.execPath, "-e", script] }],
		artifactPaths: ["nested/result.bin"],
	};
	await writeFile(join(root, "ci.json"), JSON.stringify(config));
	await writeFile(join(root, "pipeline.json"), JSON.stringify(plan));
	const { project, pipeline } = await loadAdoProject(root, "ci.json");
	return {
		root,
		config,
		plan,
		project,
		pipeline,
		digest: adoPlanDigest(project, pipeline),
	};
}
const run = (root: string, extra: string[] = [], env = process.env) =>
	exec(process.execPath, [cli, "run", "ci.json", root, ...extra], {
		env,
		timeout: 5000,
	});

describe("production execution boundaries", () => {
	it("publishes collected snapshots and verifies their downloaded copies", async () => {
		const f = await fixture();
		const bundle = join(f.root, "bundle");
		await run(f.root, ["--artifacts", bundle, "--expected-plan", f.digest]);
		await writeFile(
			join(f.root, "nested/result.bin"),
			"source changed after execution",
		);
		expect([
			...(await readFile(join(bundle, "artifacts/nested/result.bin"))),
		]).toEqual([0, 255, 7]);
		const downloaded = join(f.root, "downloaded");
		await cp(bundle, downloaded, { recursive: true });
		const report = await verifyArtifactBundle(
			downloaded,
			f.digest,
			f.pipeline.artifactPaths,
		);
		expect(report.status).toBe("succeeded");
		expect(report.artifacts[0]?.sizeBytes).toBe(3);
		const verified = await exec(process.execPath, [
			cli,
			"verify",
			downloaded,
			"--config",
			"ci.json",
			"--workspace",
			f.root,
			"--expected-plan",
			f.digest,
		]);
		expect(verified.stdout).toContain("Verified 1 artifacts");
		await chmod(join(downloaded, "artifacts/nested/result.bin"), 0o600);
		await writeFile(
			join(downloaded, "artifacts/nested/result.bin"),
			Buffer.from([0, 255, 8]),
		);
		await expect(
			verifyArtifactBundle(downloaded, f.digest, f.pipeline.artifactPaths),
		).rejects.toThrow(/integrity mismatch/);
	});
	it("refuses stale generated intent before executing a check", async () => {
		const f = await fixture(
			'require("node:fs").writeFileSync("side-effect","bad")',
		);
		await expect(
			run(f.root, ["--expected-plan", "a".repeat(64)]),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("regenerate YAML"),
		});
		await expect(readFile(join(f.root, "side-effect"))).rejects.toThrow();
	});
	it("anchors the manifest to the producer digest and requires every declared artifact", async () => {
		const f = await fixture();
		const bundle = join(f.root, "bundle");
		await run(f.root, ["--artifacts", bundle]);
		const report = await verifyArtifactBundle(
			bundle,
			f.digest,
			f.pipeline.artifactPaths,
		);
		const expected = artifactReportDigest(report);
		await expect(
			verifyArtifactBundle(
				bundle,
				f.digest,
				f.pipeline.artifactPaths,
				expected,
			),
		).resolves.toMatchObject({ status: "succeeded" });
		await expect(
			verifyArtifactBundle(bundle, f.digest, f.pipeline.artifactPaths, ""),
		).rejects.toThrow(/invalid.*digest/);
		const manifest = join(bundle, "result.json");
		await chmod(manifest, 0o600);
		await writeFile(
			manifest,
			(await readFile(manifest, "utf8")).replace(
				report.executionId,
				"another-execution",
			),
		);
		await expect(
			verifyArtifactBundle(
				bundle,
				f.digest,
				f.pipeline.artifactPaths,
				expected,
			),
		).rejects.toThrow(/manifest digest mismatch/);
		await expect(
			verifyArtifactBundle(bundle, f.digest, [
				"nested/result.bin",
				"missing.txt",
			]),
		).rejects.toThrow(/expected successful execution/);
	});
	it("fails before side effects when an output directory already exists", async () => {
		const f = await fixture(
			'require("node:fs").writeFileSync("side-effect","bad")',
		);
		await mkdir(join(f.root, "bundle"));
		await expect(
			run(f.root, ["--artifacts", join(f.root, "bundle")]),
		).rejects.toMatchObject({ code: 1 });
		await expect(readFile(join(f.root, "side-effect"))).rejects.toThrow();
	});
	it("binds only declared environment values and redacts the complete log value", async () => {
		const secret = "fixture-secret-that-must-not-leak";
		const f = await fixture(
			'if (process.env.UNDECLARED) process.exit(3); console.log(process.env.TOKEN); console.error(process.env.TOKEN); require("node:fs").mkdirSync("nested");require("node:fs").writeFileSync("nested/result.bin","ok")',
			{ TOKEN: "ADO_TEST_TOKEN" },
		);
		const result = await run(f.root, ["--artifacts", join(f.root, "bundle")], {
			...process.env,
			ADO_TEST_TOKEN: secret,
			UNDECLARED: "no",
		});
		expect(result.stdout + result.stderr).not.toContain(secret);
		expect(result.stdout).toContain("***");
		expect(
			await readFile(join(f.root, "bundle/result.json"), "utf8"),
		).not.toContain(secret);
		const direct = await runAdoPipeline(f.root, f.pipeline, {
			project: f.project,
			hostEnvironment: { ADO_TEST_TOKEN: secret },
		});
		// The second command fails because its source directory already exists, but logs stay redacted.
		expect(direct.steps[0]?.stdout).not.toContain(secret);
	});
	it.each([
		undefined,
		"",
		"$(ADO_TEST_TOKEN)",
	])("rejects missing/unresolved required environment value %s", async (value) => {
		const f = await fixture(
			'require("node:fs").writeFileSync("side-effect","bad")',
			{ TOKEN: "ADO_TEST_TOKEN" },
		);
		const host: NodeJS.ProcessEnv = {};
		if (value !== undefined) host.ADO_TEST_TOKEN = value;
		await expect(
			runAdoPipeline(f.root, f.pipeline, {
				project: f.project,
				hostEnvironment: host,
			}),
		).rejects.toThrow(/environment reference/);
		await expect(readFile(join(f.root, "side-effect"))).rejects.toThrow();
	});
	it("retains failure evidence without publishing partial artifacts or reporting success", async () => {
		const f = await fixture('console.error("a check failed");process.exit(9)');
		const bundle = join(f.root, "bundle");
		await expect(
			run(f.root, ["--artifacts", bundle], {
				...process.env,
				TF_BUILD: "True",
			}),
		).rejects.toMatchObject({
			code: 1,
			stdout: expect.stringContaining("HOBO_CI_BUNDLE_READY]true"),
		});
		const report = JSON.parse(
			await readFile(join(bundle, "result.json"), "utf8"),
		);
		expect(report.status).toBe("failed");
		expect(report.artifacts).toEqual([]);
		await expect(
			verifyArtifactBundle(bundle, f.digest, f.pipeline.artifactPaths),
		).rejects.toThrow(/successful execution/);
	});
	it("rejects FIFO artifacts without hanging the process or its cleanup", async () => {
		const f = await fixture(
			'require("node:child_process").execFileSync("mkfifo",["fifo"])',
		);
		await writeFile(
			join(f.root, "pipeline.json"),
			JSON.stringify({ ...f.plan, artifactPaths: ["fifo"] }),
		);
		await expect(run(f.root)).rejects.toMatchObject({
			code: 1,
			signal: null,
			stdout: expect.stringContaining("HoBo CI: failed"),
		});
	});
	it("enforces the deadline and writes an accurate timed-out report", async () => {
		const f = await fixture(
			'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
		);
		await writeFile(
			join(f.root, "pipeline.json"),
			JSON.stringify({ ...f.plan, timeoutSeconds: 1, artifactPaths: [] }),
		);
		const bundle = join(f.root, "bundle");
		await expect(run(f.root, ["--artifacts", bundle])).rejects.toMatchObject({
			code: 1,
			stdout: expect.stringContaining("timed_out"),
		});
		expect(
			JSON.parse(await readFile(join(bundle, "result.json"), "utf8")).status,
		).toBe("timed_out");
	});
});

describe("deployable YAML", () => {
	it("checks generated YAML freshness and pins all command/config changes", async () => {
		const f = await fixture();
		const yaml = renderAzurePipeline(f.project, f.pipeline, "ci.json");
		await writeFile(join(f.root, "azure-pipelines.yml"), yaml);
		await expect(
			exec(process.execPath, [
				cli,
				"yaml",
				"ci.json",
				f.root,
				"--check",
				"azure-pipelines.yml",
			]),
		).resolves.toMatchObject({
			stdout: expect.stringContaining("configuration is current"),
		});
		await writeFile(
			join(f.root, "pipeline.json"),
			JSON.stringify({ ...f.plan, timeoutSeconds: 8 }),
		);
		await expect(
			exec(process.execPath, [
				cli,
				"yaml",
				"ci.json",
				f.root,
				"--check",
				"azure-pipelines.yml",
			]),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("is stale"),
		});
	});
	it("uses attempt-scoped artifact names and the producer output in the native consumer", async () => {
		const f = await fixture();
		const yaml = parse(renderAzurePipeline(f.project, f.pipeline, "ci.json"));
		expect(yaml.jobs).toHaveLength(2);
		expect(yaml.jobs[0].steps.at(-1).inputs.artifact).toBe(
			"checks-$(System.JobId)-$(System.JobAttempt)",
		);
		expect(yaml.jobs[1].variables.hoboArtifactName).toBe(
			"$[ dependencies.hobo_ci.outputs['artifact_identity.artifactName'] ]",
		);
		expect(yaml.jobs[1].steps[2]).toMatchObject({
			task: "DownloadPipelineArtifact@2",
			inputs: { buildType: "current", artifactName: "$(hoboArtifactName)" },
		});
		expect(
			yaml.jobs.every(
				(job: { pool: { name: string } }) => job.pool.name === "hobo-local",
			),
		).toBe(true);
	});
	it("maps declared secret sources only onto the check task", async () => {
		const f = await fixture(undefined, { TOKEN: "ADO_TEST_TOKEN" });
		const yaml = parse(renderAzurePipeline(f.project, f.pipeline, "ci.json"));
		expect(yaml.jobs[0].steps[2].env).toBeUndefined();
		expect(yaml.jobs[0].steps[3].env.ADO_TEST_TOKEN).toBe("$(ADO_TEST_TOKEN)");
		expect(yaml.jobs[1].steps.at(-1).env.ADO_TEST_TOKEN).toBeUndefined();
	});
	it("can use a consumer-project runner/bootstrap and turn off round-trip jobs explicitly", async () => {
		const f = await fixture();
		const project = parseAdoProject(
			JSON.stringify({
				...f.config,
				runnerArgv: ["pnpm", "exec", "hobo-ci-ado"],
				bootstrapArgv: ["pnpm", "install", "--frozen-lockfile"],
				verifyArtifacts: false,
			}),
		);
		const yaml = parse(renderAzurePipeline(project, f.pipeline, "ci.json"));
		expect(yaml.jobs).toHaveLength(1);
		expect(yaml.jobs[0].steps[2].bash).toContain("'pnpm' 'install'");
		expect(yaml.jobs[0].steps[3].bash).toContain(
			"'pnpm' 'exec' 'hobo-ci-ado' run",
		);
		expect(yaml.jobs[0].steps[3].bash).not.toContain("packages/ci-ado");
	});
	it("hashes maps canonically rather than depending on JSON property insertion order", async () => {
		const f = await fixture();
		const first = parseAdoProject(
			JSON.stringify({
				...f.config,
				environmentRefs: { A: "SOURCE_A", B: "SOURCE_B" },
			}),
		);
		const second = parseAdoProject(
			JSON.stringify({
				...f.config,
				environmentRefs: { B: "SOURCE_B", A: "SOURCE_A" },
			}),
		);
		expect(adoPlanDigest(first, f.pipeline)).toBe(
			adoPlanDigest(second, f.pipeline),
		);
	});
	it.each([
		{ runnerArgv: ["node", "$(unsafe)"] },
		{ bootstrapArgv: ["bash", "-c", "${{ unsafe }}"] },
		{ environmentRefs: { HOBO_CI_EXECUTION_ID: "TOKEN" } },
		{ environmentRefs: { TOKEN: "HOBO_CI_BUNDLE_READY" } },
	])("rejects Azure expression/metadata injection %j", async (fields) => {
		const f = await fixture();
		expect(() =>
			parseAdoProject(JSON.stringify({ ...f.config, ...fields })),
		).toThrow();
	});
});

it("executes both generated jobs through Pact-checked native artifact task connections", async () => {
	const f = await fixture();
	f.config.artifactPrefix = "hobo";
	await writeFile(join(f.root, "ci.json"), JSON.stringify(f.config));
	const { project, pipeline } = await loadAdoProject(f.root, "ci.json");
	const document = parse(renderAzurePipeline(project, pipeline, "ci.json"));
	const matched = new Set<string>();
	function taskContract(step: {
		task: string;
		inputs: Record<string, string>;
	}) {
		const interaction = artifactPact.interactions.find(
			(row) => row.response[0]?.contents.task === step.task,
		);
		if (!interaction) throw new Error(`unbrokered native task: ${step.task}`);
		const expected = interaction.response[0]?.contents;
		if (!expected) throw new Error("missing native task Pact response");
		expect(step.inputs).toEqual(expected.inputs);
		matched.add(interaction.description);
	}
	const temporary = await directory();
	const service = await directory();
	const variables = new Map([
		["Build.SourcesDirectory", f.root],
		["Agent.TempDirectory", temporary],
		["System.JobId", "producer"],
		["System.JobAttempt", "1"],
	]);
	const expand = (value: string) =>
		value.replace(/\$\(([^)]+)\)/g, (_match, name: string) => {
			const result = variables.get(name);
			if (result === undefined)
				throw new Error(`unbound native variable: ${name}`);
			return result;
		});
	const outputVariables: Record<string, string> = {};
	async function script(step: {
		bash: string;
		env?: Record<string, string>;
		name?: string;
	}) {
		const environment = Object.fromEntries(
			Object.entries(step.env ?? {}).map(([name, value]) => [
				name,
				expand(value),
			]),
		);
		const output = await exec("bash", ["-euo", "pipefail", "-c", step.bash], {
			cwd: f.root,
			env: { ...process.env, ...environment, TF_BUILD: "True" },
			timeout: 5000,
		});
		for (const line of output.stdout.split("\n")) {
			const variable =
				/^##vso\[task.setvariable variable=([^;\]]+)(;isOutput=true(?:;isReadOnly=true)?)?\](.*)$/.exec(
					line,
				);
			if (variable?.[1] && variable[3] !== undefined) {
				if (variable[2])
					outputVariables[`${step.name}.${variable[1]}`] = variable[3];
				else variables.set(variable[1], variable[3]);
			}
		}
		return output.stdout;
	}
	for (const step of document.jobs[0].steps) {
		if (step.bash) {
			await script(step);
			if (step.displayName === "Run HoBo CI checks")
				await writeFile(
					join(f.root, "nested/result.bin"),
					"mutation before publication",
				);
		} else if (step.task) {
			taskContract(step);
			expect(step.task).toBe("PublishPipelineArtifact@1");
			expect(variables.get("HOBO_CI_BUNDLE_READY")).toBe("true");
			const name = expand(step.inputs.artifact);
			await cp(expand(step.inputs.targetPath), join(service, name), {
				recursive: true,
			});
		}
	}
	variables.set(
		"hoboArtifactName",
		outputVariables["artifact_identity.artifactName"] ?? "",
	);
	variables.set(
		"hoboBundleDigest",
		outputVariables["run_checks.bundleDigest"] ?? "",
	);
	variables.set("System.JobId", "consumer");
	let verification = "";
	for (const step of document.jobs[1].steps) {
		if (step.bash) verification = await script(step);
		else if (step.task) {
			taskContract(step);
			expect(step.task).toBe("DownloadPipelineArtifact@2");
			expect(step.inputs.buildType).toBe("current");
			await cp(
				join(service, expand(step.inputs.artifactName)),
				expand(step.inputs.targetPath),
				{ recursive: true },
			);
		}
	}
	expect(verification).toContain("Verified 1 artifacts");
	expect(matched.size).toBe(artifactPact.interactions.length);
	expect([
		...(await readFile(
			join(
				temporary,
				"hobo-ci-download-consumer-1/artifacts/nested/result.bin",
			),
		)),
	]).toEqual([0, 255, 7]);
}, 10000);

it("routes ADO through durable CI reservations and replays completion without running side effects twice", async () => {
	const f = await fixture();
	const now = "2026-10-29T12:00:00Z";
	const account = create(AccountSchema, {
		id: "local",
		budgetMicros: 1000,
		maxRuntimeMinutes: 1,
		startupMinutes: 1,
		offers: [
			create(OfferSchema, {
				id: "local-pool",
				provider: "azure-devops",
				backend: "ado",
				providerAccountId: "organization-pool",
				enabled: true,
				bridgeAcknowledged: true,
				runsOn: "hobo-local",
				concurrency: 1,
				observedAt: "2026-10-29T11:00:00Z",
				validUntil: "2026-10-30T11:00:00Z",
				sourceUrl: "https://dev.azure.com/example",
				budgetMicros: 1000,
				priceMicrosPerMinute: 0,
				freeMinutes: 0,
			}),
		],
	});
	const configuration = parseConfiguration(
		toJsonString(
			ConfigurationSchema,
			create(ConfigurationSchema, { accounts: [account], connections: [] }),
		),
	);
	expect(configuration.accounts[0]?.offers[0]?.backend).toBe("ado");
	const path = join(f.root, "ledger.sqlite");
	let store = new LeaseStore(path);
	try {
		store.configure(configuration, 0, now);
		const scheduler = new PipelineScheduler(
			store,
			"local",
			new Map([["local-pool", createAdoBackend({ workspace: f.root })]]),
			() => now,
		);
		const first = await scheduler.execute(account, f.pipeline);
		expect(first.status).toBe("succeeded");
		expect(first.backend).toBe("ado");
		store.close();
		store = new LeaseStore(path);
		store.recover(now);
		const replay = new PipelineScheduler(
			store,
			"local",
			new Map([["local-pool", createAdoBackend({ workspace: f.root })]]),
			() => now,
		);
		const second = await replay.execute(account, f.pipeline);
		expect(second).toEqual(first);
		expect(store.all()).toHaveLength(1);
		expect(store.all()[0]?.state).toBe("completed");
	} finally {
		store.close();
	}
});
