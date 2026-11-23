import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import {
	type FleetState,
	HOSTED_RUNNER_PROVIDERS,
	type MachineCandidate,
	NO_ROUTE_FACTS,
	type RelayJobAnswer,
	type RelayJobMessage,
	runnerProviderOfLabel,
} from "../../../packages/ci/src/index.js";
import { testRelayJobMessage } from "../../../packages/ci/src/runner-order/testing.js";
import {
	RUNNER_SHA256,
	RUNNER_SHA256_ARM64,
	RUNNER_VERSION,
	runnerDownloadFor,
} from "../../../packages/ci-gh-actions/src/bootstrap.js";
import {
	signWebhookBody,
	verifyWebhookSignature,
} from "../../../packages/ci-gh-actions/src/webhook-signature.js";
import { runCiRoute } from "../../../packages/hobo/src/ci-route.js";
import { FakeParityDriver, type ParityDriver } from "./driver.js";

type DataTable = Readonly<{ hashes(): Record<string, string>[] }>;
type CommandResult = Awaited<ReturnType<typeof runCiRoute>>;

type ParityState = {
	driver: ParityDriver;
	repository: string;
	inputs: Array<readonly [string, string]>;
	origin: Readonly<{ private: boolean; fork: boolean; event: string }>;
	machines: MachineCandidate[];
	fleet: FleetState | undefined;
	answer: RelayJobAnswer | undefined;
	runs: CommandResult[];
	downloads: Array<Readonly<{ url: string; sha256: string }>>;
	webhook: Readonly<{ secret: string; body: Uint8Array; signature: string }> | undefined;
};

let state: ParityState;

Before({ tags: "@parity" }, () => {
	state = {
		driver: new FakeParityDriver(),
		repository: "octo/app",
		inputs: [],
		origin: { private: true, fork: false, event: "push" },
		machines: [],
		fleet: undefined,
		answer: undefined,
		runs: [],
		downloads: [],
		webhook: undefined,
	};
});

function list(text: string): string[] {
	return text
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

function output(answer: RelayJobAnswer | undefined, name: string): string {
	return answer?.outputs.find((value) => value.name === name)?.value ?? "";
}

function message(): RelayJobMessage {
	return testRelayJobMessage({
		repository: state.repository,
		inputs: state.inputs,
		private: state.origin.private,
		fork: state.origin.fork,
		event: state.origin.event,
	});
}

async function lastDecision() {
	const decided = (await state.driver.journal()).find(
		(event) => event.type === "runner.route.Decided",
	);
	assert.ok(decided?.decision, "the journal holds a decision");
	return decided.decision;
}


Given(
	"the runner order of {string} is {string}",
	(repository: string, keys: string) => {
		state.repository = repository;
		state.driver.commitOrder(
			repository,
			JSON.stringify({ steps: list(keys).map((key) => ({ key })) }),
		);
	},
);

Given(
	"a relay job for {string} names these runner types:",
	(repository: string, table: DataTable) => {
		state.repository = repository;
		state.inputs = table.hashes().map((row) => [row.type ?? "", row.labels ?? ""]);
	},
);

Given("no machine is connected", () => {
	state.machines = [];
});

Given(
	"a connected machine {string} with labels {string} and {int} free slot(s)",
	(id: string, labels: string, slots: number) => {
		state.machines.push({
			id,
			name: id,
			runsOn: `hobo-machine-${id}`,
			labels: list(labels),
			online: true,
			paused: false,
			slots,
			busy: 0,
			sharing: "only_me",
			ownerId: "42",
			ownerCanRead: true,
			lastPickedAtMs: 0,
			repository: undefined,
		});
	},
);

Given(
	"a busy connected machine {string} with labels {string}",
	(id: string, labels: string) => {
		state.machines.push({
			id,
			name: id,
			runsOn: `hobo-machine-${id}`,
			labels: list(labels),
			online: true,
			paused: false,
			slots: 1,
			busy: 1,
			sharing: "only_me",
			ownerId: "42",
			ownerCanRead: true,
			lastPickedAtMs: 0,
			repository: undefined,
		});
	},
);

Given("the fleet is taking jobs but does not isolate them", () => {
	state.fleet = { enabled: true, taking: true, isolated: false };
});

Given("the fleet isolates each job", () => {
	state.fleet = { enabled: true, taking: true, isolated: true };
});

Given("the relay job comes from a public repository", () => {
	state.origin = { private: false, fork: false, event: "push" };
});

Given("the relay job comes from a fork's pull request", () => {
	state.origin = { private: true, fork: true, event: "pull_request" };
});

When("the relay answers the relay job", async () => {
	state.driver.setFacts({
		...NO_ROUTE_FACTS,
		fleet: state.fleet,
		machines: [...state.machines],
	});
	state.answer = await state.driver.answer(message());
});

Then(
	"the relay job succeeds on {string} from the {string} step",
	(runner: string, step: string) => {
		assert.equal(state.answer?.conclusion, "succeeded", output(state.answer, "reason"));
		assert.equal(output(state.answer, "runner"), runner);
		assert.equal(output(state.answer, "step"), step);
	},
);

Then(
	"the relay job waits on {string} from the {string} step",
	(runner: string, step: string) => {
		assert.equal(state.answer?.conclusion, "succeeded");
		assert.equal(output(state.answer, "outcome"), "waiting");
		assert.equal(output(state.answer, "runner"), runner);
		assert.equal(output(state.answer, "step"), step);
	},
);

Then("the relay job fails with a reason naming {string}", (text: string) => {
	assert.equal(state.answer?.conclusion, "failed");
	assert.match(output(state.answer, "reason"), new RegExp(text, "u"));
	assert.ok(
		state.answer?.annotations.some((note) => note.level === "error"),
		"a failed relay job carries an error annotation",
	);
});

Then(
	"the journaled decision passed over {string} because {string}",
	async (key: string, reason: string) => {
		const decision = await lastDecision();
		assert.ok(
			decision.skipped.some((skip) => skip.key === key && skip.reason === reason),
			`expected ${key} skipped as ${reason}, got ${JSON.stringify(decision.skipped.map((s) => [s.key, s.reason]))}`,
		);
	},
);

Then(
	"the journaled decision lists {string} as not in the runner order",
	async (key: string) => {
		const decision = await lastDecision();
		assert.ok(decision.notInOrder.includes(key), decision.notInOrder.join(", "));
		assert.notEqual(decision.step, key);
	},
);


When("the pinned runner download is read for each architecture", () => {
	state.downloads = ["x64", "arm64"].map((arch) => runnerDownloadFor(arch));
});

Then("each names one pinned runner version and its own SHA-256 checksum", () => {
	const [x64, arm64] = state.downloads;
	assert.ok(x64 && arm64);
	for (const download of [x64, arm64]) {
		assert.match(download.url, new RegExp(`/v${RUNNER_VERSION}/`, "u"));
		assert.match(download.url, /^https:\/\/github\.com\/actions\/runner\/releases\//u);
		assert.match(download.sha256, /^[0-9a-f]{64}$/u);
	}
	assert.equal(x64.sha256, RUNNER_SHA256);
	assert.equal(arm64.sha256, RUNNER_SHA256_ARM64);
	assert.notEqual(x64.sha256, arm64.sha256);
});


Then("the hosted providers a runner order can name are:", (table: DataTable) => {
	assert.deepEqual(
		[...HOSTED_RUNNER_PROVIDERS],
		table.hashes().map((row) => row.provider),
	);
});

Then(
	"the label {string} is recognised as {string}",
	(label: string, provider: string) => {
		assert.equal(runnerProviderOfLabel(label) ?? "none", provider);
	},
);


When(
	"{string} runs twice in a checkout with no runner order",
	async (command: string) => {
		const words = command.split(/\s+/u).slice(3);
		const options = new Map<string, string>();
		for (let index = 0; index < words.length; index += 2)
			options.set((words[index] ?? "").replace(/^--/u, ""), words[index + 1] ?? "");
		for (let run = 0; run < 2; run += 1)
			state.runs.push(
				await runCiRoute({
					cwd: "/parity/checkout",
					repository: "octo/app",
					options: Object.fromEntries(options),
					readText: async () => undefined,
				}),
			);
	},
);

Then("both runs give the same answer", () => {
	assert.equal(state.runs.length, 2);
	assert.deepEqual(state.runs[0], state.runs[1]);
});

Then("the answer is a sentence for people and data for --json", () => {
	const result = state.runs[0];
	assert.ok(result);
	const sentence = result.message ?? "";
	assert.ok(/\.$/mu.test(sentence), "the result reads as sentences");
	assert.ok(result.data !== undefined, "the result carries data for --json");
	assert.deepEqual(JSON.parse(JSON.stringify(result.data)), result.data);
});


Given("a webhook body signed with the relay's secret", () => {
	const secret = "parity-secret";
	const body = new TextEncoder().encode('{"action":"queued"}');
	state.webhook = { secret, body, signature: signWebhookBody(secret, body) };
});

Then("the signature check accepts it", () => {
	const hook = state.webhook;
	assert.ok(hook);
	assert.equal(verifyWebhookSignature(hook.secret, hook.body, hook.signature), "valid");
});

Then(
	"it refuses another secret's signature, a changed body and a missing signature",
	() => {
		const hook = state.webhook;
		assert.ok(hook);
		assert.equal(
			verifyWebhookSignature(hook.secret, hook.body, signWebhookBody("other", hook.body)),
			"mismatch",
		);
		assert.equal(
			verifyWebhookSignature(
				hook.secret,
				new TextEncoder().encode('{"action":"completed"}'),
				hook.signature,
			),
			"mismatch",
		);
		assert.equal(verifyWebhookSignature(hook.secret, hook.body, undefined), "malformed");
	},
);
