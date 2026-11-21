import { create } from "@bufbuild/protobuf";
import {
	answerRelayJob,
	RelayJobAnswerSchema,
	RelayJobStepSchema,
	RelayJobValueSchema,
} from "@hobo/ci";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testRelayJobMessage,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	GithubRunnerServiceClient,
	RelayModeOffError,
	RunnerProtocolError,
	type RunnerProtocolEvent,
} from "../src/runner-protocol/client.js";
import {
	FAKE_RUN_SERVICE_URL,
	FakeGithubRunnerService,
} from "../src/runner-protocol/fake-service.js";
import { parseJitConfig } from "../src/runner-protocol/jit-config.js";
import { runnerServiceClientConformance } from "../src/runner-protocol/port.js";
import { completeJobBody } from "../src/runner-protocol/wire.js";

const ON = { answer: true, label: "hobo-relay" } as const;

function setup(
	options: Readonly<{
		nowMs?: () => number;
		fetch?: typeof fetch;
		callTimeoutMs?: number;
		relayJobs?: Readonly<{ answer: boolean; label: string }>;
	}> = {},
) {
	const nowMs = options.nowMs ?? Date.now;
	const service = new FakeGithubRunnerService({ nowMs });
	const events: RunnerProtocolEvent[] = [];
	const client = new GithubRunnerServiceClient({
		relayJobs: options.relayJobs ?? ON,
		fetch: options.fetch ?? service.fetch,
		callTimeoutMs: options.callTimeoutMs ?? 2_000,
		onEvent: (event) => events.push(event),
		nowMs,
	});
	const jit = parseJitConfig(service.jitConfig("hobo-relay-1"), {
		runnerName: "hobo-relay-1",
	});
	return { service, client, jit, events };
}

const answer = (jobId: string) =>
	create(RelayJobAnswerSchema, {
		jobId,
		planId: "plan-1",
		conclusion: "succeeded",
		outputs: [{ name: "runner", value: "ubuntu-24.04" }],
	});

// Match the workflow installed by `hobo ci init --relay`; real runner
// messages include its setup actions and evaluator script.
const ROUTING_SCRIPT = [
	"node --no-warnings .hobo-ci/relay.mjs",
	'--fleet "$RELAY_FLEET" --machine "$RELAY_MACHINE" --github "$RELAY_GITHUB"',
	'--blacksmith "$RELAY_BLACKSMITH" --depot "$RELAY_DEPOT" --namespace "$RELAY_NAMESPACE"',
	'--warpbuild "$RELAY_WARPBUILD" --ubicloud "$RELAY_UBICLOUD" --boat "$RELAY_BOAT"',
	'--runs-on "$RELAY_RUNS_ON" --size "$RELAY_SIZE" --first "$RELAY_FIRST"',
	'--repository "$GITHUB_REPOSITORY" --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT"',
	'--job "$GITHUB_JOB" --event "$GITHUB_EVENT_NAME" --actor-id "$GITHUB_ACTOR_ID"',
	'--triggering-actor-id "$RELAY_TRIGGERING_ACTOR_ID" --private "$RELAY_PRIVATE"',
	'--fork "$RELAY_FORK" --workflow-ref "$GITHUB_WORKFLOW_REF"',
].join(" ");

function testRoutingJob(init: Parameters<typeof testRelayJobMessage>[0] = {}) {
	const message = testRelayJobMessage(init);
	if (message.steps.length === 0)
		message.steps = [
			create(RelayJobStepSchema, {
				uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
			}),
			create(RelayJobStepSchema, {
				uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
			}),
			create(RelayJobStepSchema, {
				uses: "",
				inputs: [{ name: "script", value: ROUTING_SCRIPT }],
			}),
		];
	return message;
}

describe("GithubRunnerServiceClient", () => {
	it("keeps the runner service port's rules against the fake service", () =>
		runnerServiceClientConformance(
			() => {
				const { service, client, jit } = setup();
				return { client, jit, queue: (message) => void service.queue(message) };
			},
			{
				message: (jobId) => testRoutingJob({ jobId }),
				answer,
			},
		));

	it("takes a relay job, answers it with the one engine, and completes it with outputs", async () => {
		const { service, client, jit } = setup();
		service.queue(
			testRoutingJob({
				jobId: "a6d7f1c2-0000-4000-8000-000000000001",
				planId: "b6d7f1c2-0000-4000-8000-000000000002",
				repository: "octo/app",
				workflowRef: "octo/app/.github/workflows/ci.yml@refs/heads/main",
				inputs: [
					["github", "ubuntu-24.04"],
					["size", ""],
				],
			}),
		);
		const session = await client.open(jit);
		const message = await session.nextJob(1_000);
		expect(message).toMatchObject({
			jobId: "a6d7f1c2-0000-4000-8000-000000000001",
			planId: "b6d7f1c2-0000-4000-8000-000000000002",
			repository: "octo/app",
			runId: 9001,
			runAttempt: 1,
			job: "route",
			event: "push",
			actorId: "42",
			triggeringActorId: "42",
			private: true,
			fork: false,
			workflowRef: "octo/app/.github/workflows/ci.yml@refs/heads/main",
		});
		expect(message?.inputs.map((input) => [input.name, input.value])).toEqual([
			["github", "ubuntu-24.04"],
			["size", ""],
		]);
		if (!message) throw new Error("no job");
		const relayAnswer = await answerRelayJob(message, {
			order: new InMemoryRunnerOrderSource(),
			facts: new InMemoryRouteFactsSource(),
			journal: new InMemoryRouteJournal(),
			nowMs: 1_700_000_000_000,
			mode: "relay",
			node: "relay-test",
			accountId: "acct-1",
			checks: undefined,
		});
		await session.complete(relayAnswer);
		await session.close();
		expect(service.completions).toHaveLength(1);
		const completion = service.completions[0];
		expect(completion?.conclusion).toBe("succeeded");
		expect(completion?.outputs.get("runner")).toBe("ubuntu-24.04");
		expect(completion?.outputs.get("outcome")).toBe("routed");
		expect(service.requests.map((request) => request.call)).toEqual([
			"token",
			"session",
			"message",
			"acknowledge",
			"acquirejob",
			"completejob",
			"close",
		]);
	});

	it("fails a relay job whose order is broken, with the reason as a failure annotation", async () => {
		const { service, client, jit } = setup();
		service.queue(testRoutingJob({ jobId: "job-broken" }));
		const session = await client.open(jit);
		const message = await session.nextJob(1_000);
		if (!message) throw new Error("no job");
		const order = new InMemoryRunnerOrderSource(
			new Map([["octo/app", '{"steps": "not a list"}']]),
		);
		const problem = (await order.order("octo/app", undefined)).problem;
		expect(problem).not.toBe("");
		await session.complete(
			await answerRelayJob(message, {
				order,
				facts: new InMemoryRouteFactsSource(),
				journal: new InMemoryRouteJournal(),
				nowMs: 1,
				mode: "relay",
				node: "relay-test",
				accountId: "acct-1",
				checks: undefined,
			}),
		);
		expect(service.completions[0]?.conclusion).toBe("failed");
		expect(service.completions[0]?.annotations).toEqual([
			{ level: "failure", message: problem },
		]);
		await session.close();
	});

	it("reads the fork, visibility and steps of a job", async () => {
		const { service, client, jit } = setup();
		service.queue(
			testRoutingJob({
				jobId: "job-fork",
				event: "pull_request",
				private: false,
				fork: true,
				inputs: [],
				uses: ["hobo-labs/hobo/checks/pr-title@v1"],
			}),
		);
		const session = await client.open(jit);
		const message = await session.nextJob(1_000);
		expect(message?.private).toBe(false);
		expect(message?.fork).toBe(true);
		expect(message?.steps.map((step) => step.uses)).toEqual([
			"hobo-labs/hobo/checks/pr-title@v1",
		]);
		await session.close();
	});

	it("opens nothing while relay mode is off", async () => {
		const { service, client, jit } = setup({
			relayJobs: { answer: false, label: "hobo-relay" },
		});
		await expect(client.open(jit)).rejects.toBeInstanceOf(RelayModeOffError);
		expect(service.requests).toEqual([]);
	});

	it("refuses a configuration that does not use the broker flow", async () => {
		const { client, jit } = setup();
		const v1 = { ...jit, runner: { ...jit.runner, useV2Flow: false } };
		await expect(client.open(v1)).rejects.toThrow(/broker flow/u);
	});

	it("signs in again when the service says the token expired", async () => {
		let now = 1_700_000_000_000;
		const { service, client, jit, events } = setup({ nowMs: () => now });
		const session = await client.open(jit);
		service.expireTokens();
		service.queue(testRoutingJob({ jobId: "job-after-expiry" }));
		expect((await session.nextJob(1_000))?.jobId).toBe("job-after-expiry");
		expect(
			events.filter((event) => event.kind === "token-issued"),
		).toHaveLength(2);
		now += 2 * 60 * 60 * 1000;
		await session.complete(answer("job-after-expiry"));
		expect(
			events.filter((event) => event.kind === "token-issued"),
		).toHaveLength(3);
		await session.close();
	});

	it("gives up when the runner can no longer sign in", async () => {
		const { service, client, jit } = setup();
		service.failNext("token", 400);
		await expect(client.open(jit)).rejects.toThrow(
			/refused the runner's sign-in \(400\)/u,
		);
	});

	it("ignores a message type it does not know and keeps waiting for a job", async () => {
		const { service, client, jit, events } = setup();
		service.queueMessage("BrokerSomethingNew", "{}");
		service.queue(testRoutingJob({ jobId: "job-after-unknown" }));
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-after-unknown");
		expect(events).toContainEqual({
			kind: "message-ignored",
			messageType: "BrokerSomethingNew",
		});
		await session.close();
	});

	it("drops its token when the broker asks for a refresh", async () => {
		const { service, client, jit, events } = setup();
		const session = await client.open(jit);
		service.forceTokenRefresh();
		service.queue(testRoutingJob({ jobId: "job-after-refresh" }));
		expect((await session.nextJob(5_000))?.jobId).toBe("job-after-refresh");
		expect(
			events.filter((event) => event.kind === "token-issued"),
		).toHaveLength(2);
		await session.close();
	});

	it("completes a job that is not a relay job as failed and never hands it out", async () => {
		const { service, client, jit, events } = setup();
		service.queue(
			testRoutingJob({
				jobId: "job-build",
				inputs: [],
				uses: ["actions/checkout@v4"],
			}),
		);
		service.queue(testRoutingJob({ jobId: "job-relay" }));
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-relay");
		expect(service.completions[0]).toMatchObject({
			jobId: "job-build",
			conclusion: "failed",
		});
		expect(service.completions[0]?.annotations[0]?.message).toMatch(
			/not a relay job/u,
		);
		expect(events).toContainEqual(
			expect.objectContaining({ kind: "job-refused", jobId: "job-build" }),
		);
		await expect(session.complete(answer("job-build"))).rejects.toThrow(
			/not taken/u,
		);
		await session.close();
	});

	it("refuses other job steps even when a common relay input is present", async () => {
		const { service, client, jit, events } = setup();
		service.queue(
			testRoutingJob({
				jobId: "job-with-unrelated-steps",
				inputs: [["size", "4"]],
				uses: ["actions/checkout@v4", "actions/upload-artifact@v4"],
			}),
		);
		service.queue(
			testRelayJobMessage({
				jobId: "job-without-steps",
				inputs: [["size", "4"]],
			}),
		);
		service.queue(
			testRoutingJob({
				jobId: "job-with-foreign-check",
				inputs: [],
				uses: ["other-owner/other/checks/lint@v1"],
			}),
		);
		const modified = testRoutingJob({ jobId: "job-with-modified-script" });
		const script = modified.steps[2]?.inputs[0];
		if (!script) throw new Error("missing routing script fixture");
		script.value += " && npm test";
		service.queue(modified);
		const customShell = testRoutingJob({ jobId: "job-with-custom-shell" });
		const scriptStep = customShell.steps[2];
		if (!scriptStep) throw new Error("missing routing step fixture");
		scriptStep.inputs.push(
			create(RelayJobValueSchema, {
				name: "shell",
				value: "bash --rcfile ./run-tests.sh {0}",
			}),
		);
		service.queue(customShell);
		service.queue(testRoutingJob({ jobId: "job-with-shell-env" }), {
			rewriteJob: (json) => {
				const job = JSON.parse(json);
				job.steps[2].environment = {
					type: 2,
					map: [{ Key: "BASH_ENV", Value: "./run-tests.sh" }],
				};
				return JSON.stringify(job);
			},
		});
		service.queue(testRoutingJob({ jobId: "job-with-container" }), {
			rewriteJob: (json) => {
				const job = JSON.parse(json);
				job.jobContainer = { type: 0, lit: "alpine:latest" };
				return JSON.stringify(job);
			},
		});
		service.queue(testRoutingJob({ jobId: "job-relay" }), {
			rewriteJob: (json) => {
				const job = JSON.parse(json);
				job.steps[2].environment = {
					type: 2,
					map: [{ Key: "RELAY_GITHUB", Value: "ubuntu-24.04" }],
				};
				return JSON.stringify(job);
			},
		});
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-relay");
		expect(service.completions[0]).toMatchObject({
			jobId: "job-with-unrelated-steps",
			conclusion: "failed",
		});
		expect(service.completions.slice(1)).toMatchObject([
			{ jobId: "job-without-steps", conclusion: "failed" },
			{ jobId: "job-with-foreign-check", conclusion: "failed" },
			{ jobId: "job-with-modified-script", conclusion: "failed" },
			{ jobId: "job-with-custom-shell", conclusion: "failed" },
			{ jobId: "job-with-shell-env", conclusion: "failed" },
			{ jobId: "job-with-container", conclusion: "failed" },
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: "job-refused",
				jobId: "job-with-unrelated-steps",
			}),
		);
		await session.close();
	});

	it("completes as failed an acquired job whose message it cannot read, and keeps waiting", async () => {
		const { service, client, jit, events } = setup();
		service.queue(testRoutingJob({ jobId: "job-bad-context" }), {
			rewriteJob: (json) => {
				const job = JSON.parse(json);
				job.contextData.github = { notATypedContext: 1 };
				return JSON.stringify(job);
			},
		});
		service.queue(testRoutingJob({ jobId: "job-good" }));
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-good");
		expect(service.completions[0]).toMatchObject({
			jobId: "job-bad-context",
			conclusion: "failed",
		});
		expect(service.completions[0]?.annotations[0]).toMatchObject({
			level: "failure",
			message: expect.stringMatching(/could not read this job's message/u),
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: "job-unreadable",
				requestId: "1",
				jobId: "job-bad-context",
			}),
		);
		await session.close();
	});

	it("reads a job message whose dictionaries hold keys that differ only by case", async () => {
		const { service, client, jit } = setup();
		service.queue(testRoutingJob({ jobId: "job-variables" }), {
			rewriteJob: (json) => {
				const job = JSON.parse(json);
				job.variables = {
					Foo: { value: "1", isSecret: false },
					FOO: { value: "2", isSecret: false },
				};
				return JSON.stringify(job);
			},
		});
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-variables");
		await session.complete(answer("job-variables"));
		expect(service.completions[0]?.conclusion).toBe("succeeded");
		await session.close();
	});

	it("reports a job message without its ids and keeps waiting rather than throwing", async () => {
		const { service, client, jit, events } = setup();
		service.queue(testRoutingJob({ jobId: "job-no-id" }), {
			rewriteJob: (json) => {
				const job = JSON.parse(json);
				delete job.jobId;
				return JSON.stringify(job);
			},
		});
		service.queue(testRoutingJob({ jobId: "job-after-no-id" }));
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-after-no-id");
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: "job-unreadable",
				requestId: "1",
				jobId: "",
			}),
		);
		expect(service.completions).toHaveLength(0);
		await session.close();
	});

	it("completes a job as failed unless the answer says it succeeded", () => {
		const body = (conclusion: string) =>
			JSON.parse(
				completeJobBody(
					{ jobId: "job-1", conclusion, outputs: [], annotations: [] },
					"plan-1",
					"",
				),
			).conclusion;
		expect(body("succeeded")).toBe("succeeded");
		expect(body("failed")).toBe("failed");
		expect(body("")).toBe("failed");
		expect(body("cancelled")).toBe("failed");
	});

	it("reports a sign-in that runs out of time during a poll, not an empty poll", async () => {
		const { service, jit } = setup();
		let hangSignIn = false;
		const client = new GithubRunnerServiceClient({
			relayJobs: ON,
			callTimeoutMs: 50,
			fetch: async (input, init) => {
				const signIn = String(init?.body ?? "").includes("client_assertion");
				if (!(hangSignIn && signIn)) return service.fetch(input, init);
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				});
			},
		});
		const session = await client.open(jit);
		hangSignIn = true;
		service.forceTokenRefresh();
		const failure = await session.nextJob(3_000).catch((error) => error);
		expect(failure).toBeInstanceOf(RunnerProtocolError);
		expect(failure).toMatchObject({ timedOut: true, call: "OAuth token" });
		hangSignIn = false;
		await session.close();
	});

	it("retries a server error once", async () => {
		const { service, client, jit, events } = setup();
		const session = await client.open(jit);
		service.queue(testRoutingJob({ jobId: "job-retry" }));
		service.failNext("acquirejob", 503);
		expect((await session.nextJob(1_000))?.jobId).toBe("job-retry");
		expect(events).toContainEqual({
			kind: "retried",
			call: "acquirejob",
			status: 503,
		});
		service.failNext("completejob", 502);
		service.failNext("completejob", 500);
		await expect(session.complete(answer("job-retry"))).rejects.toMatchObject({
			status: 500,
		});
		await session.close();
	});

	it("does not disclose credentials in transport errors", async () => {
		let attempts = 0;
		const { client } = setup({
			fetch: async (_input, init) => {
				attempts += 1;
				const authorization = new Headers(init?.headers).get("authorization");
				throw new Error(
					`transport failed: ${authorization} ${String(init?.body)}`,
				);
			},
		});
		const failure = await client
			.send(
				{
					method: "POST",
					url: new URL("https://broker.actions.githubusercontent.com/session"),
					body: "client_assertion=fixture-assertion-secret",
					contentType: "application/x-www-form-urlencoded",
					timeoutMs: 2_000,
					name: "session",
				},
				"fixture-bearer-secret",
			)
			.catch((error) => error);
		expect(attempts).toBe(2);
		expect(failure).toBeInstanceOf(RunnerProtocolError);
		expect(failure).toMatchObject({ status: 0 });
		expect(failure.message).toContain("session");
		expect(failure.message).not.toContain("fixture-bearer-secret");
		expect(failure.message).not.toContain("fixture-assertion-secret");
	});

	it("skips an offer another runner acquired first", async () => {
		const { service, client, jit, events } = setup();
		const session = await client.open(jit);
		service.queue(testRoutingJob({ jobId: "job-taken" }));
		service.failNext("acquirejob", 409);
		service.queue(testRoutingJob({ jobId: "job-next" }));
		expect((await session.nextJob(5_000))?.jobId).toBe("job-next");
		expect(events).toContainEqual({
			kind: "job-lost",
			requestId: "1",
			status: 409,
		});
		await session.close();
	});

	it("puts a deadline on every call", async () => {
		const { service, jit } = setup();
		const hanging: typeof fetch = async (input, init) => {
			const url = new Request(input).url;
			if (url.startsWith(FAKE_RUN_SERVICE_URL) || url.endsWith("/session"))
				return service.fetch(input, init);
			if (!url.includes("/message")) return service.fetch(input, init);
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		};
		const client = new GithubRunnerServiceClient({
			relayJobs: ON,
			fetch: hanging,
			callTimeoutMs: 50,
		});
		const session = await client.open(jit);
		const started = Date.now();
		expect(await session.nextJob(0)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_500);
		await session.close();
		const slowComplete = new GithubRunnerServiceClient({
			relayJobs: ON,
			callTimeoutMs: 50,
			fetch: async (input, init) =>
				new Request(input).url.includes("completejob")
					? new Promise((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () =>
								reject(init.signal?.reason),
							);
						})
					: service.fetch(input, init),
		});
		service.queue(testRoutingJob({ jobId: "job-slow" }));
		const second = await slowComplete.open(jit);
		expect((await second.nextJob(1_000))?.jobId).toBe("job-slow");
		const failure = await second
			.complete(answer("job-slow"))
			.catch((error) => error);
		expect(failure).toBeInstanceOf(RunnerProtocolError);
		expect(failure).toMatchObject({ timedOut: true });
		await second.close();
	});

	it("sends nothing outside GitHub's hosts and never follows a redirect", async () => {
		const { service, jit } = setup();
		const seen: string[] = [];
		const client = new GithubRunnerServiceClient({
			relayJobs: ON,
			fetch: async (input, init) => {
				seen.push(new Request(input).url);
				expect(init?.redirect).toBe("error");
				return service.fetch(input, init);
			},
		});
		const session = await client.open(jit);
		service.queue(testRoutingJob({ jobId: "job-hosts" }));
		await session.nextJob(1_000);
		await session.close();
		expect(seen.length).toBeGreaterThan(0);
		for (const url of seen)
			expect(new URL(url).hostname).toMatch(
				/\.actions\.githubusercontent\.com$/u,
			);
	});
});
