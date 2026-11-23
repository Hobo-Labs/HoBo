import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import {
	NO_ROUTE_FACTS,
	type RelayJobAnswer,
	registryMachineCandidates,
} from "../../../packages/ci/src/index.js";
import { generateMeshIdentity } from "../../../packages/ci/src/mesh/index.js";
import {
	InMemoryMachineRegistry,
	testRelayJobMessage,
} from "../../../packages/ci/src/runner-order/testing.js";
import {
	machineRunsOnLabel,
	registryAdvertSink,
} from "../../../packages/ci-gh-actions/src/machine-worker/advert.js";
import { hostExecutor } from "../../../packages/ci-gh-actions/src/machine-worker/executor.js";
import { githubQueueJobSource } from "../../../packages/ci-gh-actions/src/machine-worker/jobs.js";
import {
	machineConnectPlan,
	macosRunnerDownloadFor,
	pinnedMacosRunnerProgram,
} from "../../../packages/ci-gh-actions/src/machine-worker/macos/index.js";
import {
	type FakeHostProcess,
	fakeHostProcess,
} from "../../../packages/ci-gh-actions/src/machine-worker/testing.js";
import {
	createMachineWorker,
	type MachineWorker,
} from "../../../packages/ci-gh-actions/src/machine-worker/worker.js";
import { GithubSimulator } from "../../../packages/ci-gh-actions/test/support/github-simulator/index.js";
import {
	type SimulatedRunnerRun,
	simulatedRunnerProgram,
	simulatorMachineGithub,
} from "../../../packages/ci-gh-actions/test/support/machine-connect-simulator.js";
import { FakeParityDriver, PARITY_ACCOUNT } from "./driver.js";

const MACHINE_ID = "m-mac0";
const OWNER = { accountId: PARITY_ACCOUNT, ownerId: "42", ownerLogin: "octocat" };

type MacState = {
	github: GithubSimulator;
	registry: InMemoryMachineRegistry;
	worker: MachineWorker | undefined;
	host: FakeHostProcess | undefined;
	runs: SimulatedRunnerRun[];
	cacheDir: string | undefined;
	answer: RelayJobAnswer | undefined;
	jobId: number | undefined;
};

let mac: MacState;

Before({ tags: "@M12" }, () => {
	mac = {
		github: new GithubSimulator(),
		registry: new InMemoryMachineRegistry(),
		worker: undefined,
		host: undefined,
		runs: [],
		cacheDir: undefined,
		answer: undefined,
		jobId: undefined,
	};
});

After({ tags: "@M12" }, async () => {
	if (mac.cacheDir) await rm(mac.cacheDir, { recursive: true, force: true });
});

async function settle(worker: MachineWorker): Promise<void> {
	for (let turn = 0; turn < 400 && worker.status().running > 0; turn++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(worker.status().running, 0, "the job finished");
}

Given("a connected macOS machine", async () => {
	const where = { platform: "darwin", arch: "arm64" };
	assert.equal(
		machineConnectPlan(where, { host: false, vm: false }, undefined).ok,
		false,
	);
	const plan = machineConnectPlan(where, { host: true, vm: false }, undefined);
	assert.ok(plan.ok, plan.ok ? "" : plan.reason);
	assert.equal(plan.os, "macos");
	assert.equal(plan.arch, "arm64");

	mac.github.addRepository("octo/app", true);
	const github = simulatorMachineGithub(mac.github);
	const { program, runs } = simulatedRunnerProgram(mac.github);
	mac.runs = runs;
	mac.host = fakeHostProcess(program);
	mac.cacheDir = await mkdtemp(join(tmpdir(), "hobo-parity-macos-"));
	const archive = new TextEncoder().encode("the macOS runner archive");
	const download = {
		url: macosRunnerDownloadFor("arm64").url,
		sha256: createHash("sha256").update(archive).digest("hex"),
	};
	const env = { PATH: "/usr/bin:/bin", HOME: "/Users/octocat", GH_TOKEN: "gho_cli" };
	mac.worker = createMachineWorker({
		profile: {
			id: MACHINE_ID,
			name: "studio-mac",
			os: plan.os,
			arch: plan.arch,
			isolation: plan.isolation,
			...OWNER,
		},
		identity: generateMeshIdentity().identity,
		sink: registryAdvertSink(mac.registry, OWNER),
		jobs: githubQueueJobSource({
			github,
			repositories: ["octo/app"],
			label: machineRunsOnLabel(MACHINE_ID),
			pollMs: 0,
		}),
		github,
		executor: hostExecutor({
			program: pinnedMacosRunnerProgram({
				fetch: async (url) => {
					assert.equal(String(url), download.url);
					return new Response(archive);
				},
				cacheDir: mac.cacheDir,
				arch: plan.arch,
				process: mac.host.process,
				env,
				download,
			}),
			process: mac.host.process,
			env,
		}),
		concurrency: 1,
		sharing: "only_me",
		now: () => mac.github.nowMs(),
		emit: () => {},
	});
	await mac.worker.tick();
	const [advert] = await mac.registry.list(PARITY_ACCOUNT);
	assert.ok(advert, "the machine advertised itself");
	assert.deepEqual(advert.labels, ["self-hosted", "macOS", "ARM64"]);
	assert.equal(advert.isolation, "host");
});

When("a relay job naming macOS is answered", async () => {
	const driver = new FakeParityDriver();
	driver.commitOrder(
		"octo/app",
		JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
	);
	driver.setFacts({
		...NO_ROUTE_FACTS,
		machines: [
			...(await registryMachineCandidates(mac.registry, {
				accountId: PARITY_ACCOUNT,
				nowMs: mac.github.nowMs(),
				readers: new Set(["42"]),
			})),
		],
	});
	mac.answer = await driver.answer(
		testRelayJobMessage({
			repository: "octo/app",
			inputs: [
				["machine", "self-hosted, macOS"],
				["github", "macos-15"],
			],
		}),
	);
	const runner =
		mac.answer.outputs.find((value) => value.name === "runner")?.value ?? "";
	mac.jobId = mac.github.queueJob({
		repository: "octo/app",
		name: "test-macos",
		labels: [runner],
	}).id;
	assert.ok(mac.worker);
	await mac.worker.tick();
	await settle(mac.worker);
});

Then("the job runs on the macOS machine", () => {
	assert.equal(mac.answer?.conclusion, "succeeded");
	assert.equal(
		mac.answer?.outputs.find((value) => value.name === "runner")?.value,
		machineRunsOnLabel(MACHINE_ID),
	);
	assert.deepEqual(
		mac.runs.map((run) => run.jobId),
		[mac.jobId],
	);
	assert.equal(
		mac.github.jobs().find((job) => job.id === mac.jobId)?.conclusion,
		"success",
	);
	const calls = mac.host?.calls ?? [];
	const unpack = calls.find((call) => call.command === "tar");
	assert.match(unpack?.args[1] ?? "", /actions-runner-osx-arm64-/u);
	const run = calls.find((call) => call.command.endsWith("run.sh"));
	assert.ok(run, "the runner program ran on the host");
	assert.ok(
		!Object.keys(run.env).includes("GH_TOKEN"),
		"the CLI's token never reaches the job",
	);
});
