import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import {
	InMemoryMachineRegistry,
	InMemoryRouteJournal,
} from "../../../packages/ci/src/runner-order/testing.js";
import type { GithubTransport } from "../../../packages/ci-gh-actions/src/github.js";
import {
	createRelayAnswerer,
	RELAY_CONFIG_PATH,
	type RelayAnswerer,
	StoreRouteFacts,
} from "../../../packages/ci-gh-actions/src/relay-answer/index.js";
import {
	createRelayChecks,
	GithubRelayCheckSource,
	type LintRun,
	type LintRunResult,
	type LintSandbox,
	type RelayArchiveAccess,
	type RelayCheckCompleted,
} from "../../../packages/ci-gh-actions/src/relay-checks/index.js";
import { testJitConfig } from "../../../packages/ci-gh-actions/src/runner-protocol/port.js";
import {
	GithubSimulator,
	SimulatedRunnerService,
	simulatorTransport,
} from "../../../packages/ci-gh-actions/test/support/github-simulator/index.js";

const ACCOUNT = "acct-parity";
const CHECK_SCENARIOS = "@C01 or @C02";
const PULL_NUMBER = 7;

class RecordingSandbox implements LintSandbox {
	readonly runs: LintRun[] = [];
	async run(request: LintRun): Promise<LintRunResult> {
		this.runs.push(request);
		return { exitCode: 0, output: "", timedOut: false };
	}
}

type ChecksState = {
	sim: GithubSimulator;
	repository: string;
	title: string;
	requests: string[];
	sandbox: RecordingSandbox;
	events: RelayCheckCompleted[];
	answerer: RelayAnswerer;
	journal: InMemoryRouteJournal;
	steps: { uses: string; with: ReadonlyMap<string, string> }[];
	jobId: number;
	tools: readonly string[];
};

let world: ChecksState;

type RelayParts = Pick<ChecksState, "answerer" | "journal">;
type Scene = Omit<ChecksState, keyof RelayParts>;

function transport(scene: Scene): GithubTransport {
	const inner = simulatorTransport(scene.sim);
	return {
		request: async (installationId, path, method, body, ifNoneMatch) => {
			scene.requests.push(path);
			if (path === `/repos/${scene.repository}/pulls/${PULL_NUMBER}`)
				return Response.json({ number: PULL_NUMBER, title: scene.title });
			return inner.request(installationId, path, method, body, ifNoneMatch);
		},
	};
}

function archives(scene: Scene): RelayArchiveAccess {
	return {
		installationToken: async (id) => `installation-${id}`,
		fetch: async (input) => {
			const url = String(input);
			scene.requests.push(url);
			if (url.startsWith("https://codeload.github.com/"))
				return new Response(new Uint8Array([31, 139]));
			return new Response(null, {
				status: 302,
				headers: {
					location: `https://codeload.github.com/${scene.repository}/legacy.tar.gz/head?token=short`,
				},
			});
		},
	};
}

function relay(scene: Scene): RelayParts {
	const github = transport(scene);
	const journal = new InMemoryRouteJournal();
	const answerer = createRelayAnswerer({
		relayJobs: { answer: true, label: "hobo-relay" },
		github,
		runnerService: new SimulatedRunnerService(scene.sim),
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => ACCOUNT,
		facts: (accountId) =>
			new StoreRouteFacts({
				accountId,
				fleet: undefined,
				machines: new InMemoryMachineRegistry(),
				readers: undefined,
				spend: undefined,
				health: undefined,
				minutes: undefined,
				onWarning: undefined,
			}),
		journal,
		node: "hosted",
		checks: createRelayChecks({
			source: new GithubRelayCheckSource(
				github,
				async () => 1,
				archives(scene),
			),
			sandbox: scene.sandbox,
			completed: async (event) => {
				scene.events.push(event);
			},
			node: "hosted",
			nowMs: () => scene.sim.nowMs(),
		}),
		webhookSecret: scene.sim.webhookSecret,
		nowMs: () => scene.sim.nowMs(),
	});
	return { answerer, journal };
}

function ciFile(checks: string): void {
	world.sim.putFile(
		world.repository,
		RELAY_CONFIG_PATH,
		`{ "relayJobs": { "answer": true }, "checks": ${checks} }`,
	);
}

function checkJob() {
	const found = world.sim.jobs().find((job) => job.id === world.jobId);
	assert.ok(found, "the check job is on GitHub's lists");
	return found;
}

Before({ tags: CHECK_SCENARIOS }, () => {
	const scene: Scene = {
		sim: new GithubSimulator(),
		repository: "octo/app",
		title: "",
		requests: [],
		sandbox: new RecordingSandbox(),
		events: [],
		steps: [],
		jobId: 0,
		tools: [],
	};
	world = Object.assign(scene, relay(scene));
});

Given(
	"relay mode is on for {string} with the allowed title types {string}",
	(repository: string, types: string) => {
		world.repository = repository;
		ciFile(
			JSON.stringify({
				prTitle: { types: types.split(",").map((type) => type.trim()) },
			}),
		);
		Object.assign(world, relay(world));
	},
);

Given("a relay job whose only step uses {string}", (uses: string) => {
	world.steps = [{ uses: `${uses}@v1`, with: new Map() }];
});

Given(
	"a relay job whose only step uses {string} with two tools",
	(uses: string) => {
		ciFile(JSON.stringify({ lint: true }));
		world.tools = ["actionlint", "shellcheck"];
		world.steps = [
			{ uses: `${uses}@v1`, with: new Map([["tools", world.tools.join(", ")]]) },
		];
	},
);

When("a pull request titled {string} queues it", async (title: string) => {
	world.title = title;
	world.jobId = world.sim.queueJob({
		repository: world.repository,
		name: "title",
		labels: ["hobo-relay"],
		event: "pull_request",
		workflowRef: `${world.repository}/.github/workflows/checks.yml@refs/pull/${PULL_NUMBER}/merge`,
		steps: world.steps,
	}).id;
	await world.sim.deliver(world.answerer.webhook);
});

When("the relay answers the check job", async () => {
	world.jobId = world.sim.queueJob({
		repository: world.repository,
		name: "lint",
		labels: ["hobo-relay"],
		steps: world.steps,
	}).id;
	await world.sim.deliver(world.answerer.webhook);
});

Then(
	"the relay completes the job as failed with the allowed types in its annotation",
	() => {
		const job = checkJob();
		assert.equal(job.status, "completed");
		assert.equal(job.conclusion, "failure");
		assert.match(job.annotations.join("\n"), /Use one of: feat, fix\./u);
		assert.deepEqual(
			world.events.map((event) => event.checks),
			[[{ name: "pr-title", passed: false }]],
		);
	},
);

Then("no runner took the job", async () => {
	const job = checkJob();
	assert.match(job.runnerName ?? "", /^hobo-relay-/u);
	assert.deepEqual(world.sim.runners(), []);
	assert.deepEqual(
		await world.journal.decisions({
			accountId: ACCOUNT,
			repository: undefined,
			sinceMs: 0,
			limit: 10,
		}),
		[],
	);
});

Then("each tool ran in a HoBo sandbox with no network", () => {
	assert.deepEqual(
		world.sandbox.runs.map((run) => [run.tool, run.network]),
		world.tools.map((tool) => [tool, "none"]),
	);
	assert.ok(
		world.sandbox.runs.every((run) => run.timeoutMs <= 5 * 60_000),
		"each tool has five minutes at most",
	);
});

Then("the job carries one result per tool", () => {
	const job = checkJob();
	assert.equal(job.conclusion, "success");
	assert.deepEqual(
		job.annotations,
		world.tools.map((tool) => `${tool}: passed`),
	);
});
