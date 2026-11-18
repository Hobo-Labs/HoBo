import { readdirSync, readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	RelayJobMessageSchema,
	RunnerRouteEventSchema,
} from "../src/_generated/relay_job_pb.js";
import type { InsightRun } from "../src/insights/types.js";
import {
	DEFAULT_RELAY_JOBS,
	defineRunnerRouteEvent,
	HOSTED_RUNNER_PROVIDERS,
	insightRunOf,
	isRelayCheckStep,
	machineCandidate,
	newProviderHealth,
	parityTags,
	parseMachineAdvert,
	parseProviderHealthRecord,
	parseRelayJobAnswer,
	parseRelayJobMessage,
	parseRunFact,
	parseRunnerRouteEvent,
	providerHealthOf,
	providerHealthRecord,
	RELAY_JOB_INPUTS,
	RELAY_JOB_OUTPUTS,
	RELAY_LABEL,
	RelayRecordRejection,
	recordProviderOutcome,
	relayJobInput,
	relayRouteRequest,
	runFactOf,
} from "../src/runner-order/index.js";

const fixtures = new URL("../data-models/fixtures/relay_job/", import.meta.url);
const fixture = (path: string): string =>
	readFileSync(new URL(path, fixtures), "utf8");

const PARSERS: ReadonlyMap<string, (json: string) => void> = new Map<
	string,
	(json: string) => void
>([
	["message", parseRelayJobMessage],
	["answer", parseRelayJobAnswer],
	["event", parseRunnerRouteEvent],
	["machine", parseMachineAdvert],
	["provider-health", parseProviderHealthRecord],
	["run", parseRunFact],
]);

function parserFor(name: string): (json: string) => void {
	const prefix = [...PARSERS.keys()].find((key) => name.startsWith(key));
	const parser = prefix ? PARSERS.get(prefix) : undefined;
	if (!parser) throw new Error(`no parser for fixture ${name}`);
	return parser;
}

describe("relay job records", () => {
	it("parses every valid fixture and rejects every invalid one", () => {
		const valid = readdirSync(new URL("valid/", fixtures));
		const invalid = readdirSync(new URL("invalid/", fixtures));
		expect(valid.length).toBeGreaterThan(5);
		for (const name of valid)
			expect(
				() => parserFor(name)(fixture(`valid/${name}`)),
				name,
			).not.toThrow();
		for (const name of invalid)
			expect(() => parserFor(name)(fixture(`invalid/${name}`)), name).toThrow();
	});

	it("returns frozen records", () => {
		const message = parseRelayJobMessage(fixture("valid/message.json"));
		expect(Object.isFrozen(message)).toBe(true);
		expect(Object.isFrozen(message.inputs)).toBe(true);
		expect(Object.isFrozen(message.steps[0])).toBe(true);
		const run = parseRunFact(fixture("valid/run.json"));
		expect(Object.isFrozen(run.jobs[0]?.steps)).toBe(true);
	});

	it("names the rule a record broke", () => {
		expect(() =>
			parseRelayJobAnswer(
				fixture("invalid/answer-failed-without-annotation.json"),
			),
		).toThrow(
			new RelayRecordRejection(
				"a failed answer carries at least one annotation saying why",
			),
		);
		expect(() =>
			defineRunnerRouteEvent(
				create(RunnerRouteEventSchema, {
					type: "runner.route.Requested",
					accountId: "a",
					atMs: 1,
					request: {
						repository: "o/r",
						event: "push",
						runId: 1,
						runAttempt: 1,
						job: "j",
					},
					mode: "job",
					node: "n",
					decision: { outcome: "none", reason: "x" },
				}),
			),
		).toThrow("a decision is on runner.route.Decided and nowhere else");
	});

	it("turns a relay message into the walk's request", () => {
		const message = parseRelayJobMessage(fixture("valid/message.json"));
		const request = relayRouteRequest(message);
		expect(request.inputs.map((input) => [input.key, input.labels])).toEqual([
			["machine", ["auto"]],
			["github", ["ubuntu-24.04"]],
		]);
		expect(request.repository).toBe("octo/app");
		expect(request.private).toBe(true);
		expect(relayJobInput(message, "first")).toBe("github");
		expect(relayJobInput(message, "size")).toBeUndefined();
	});

	it("splits a comma-separated input and drops an empty one", () => {
		const request = relayRouteRequest(
			create(RelayJobMessageSchema, {
				inputs: [
					{ name: "machine", value: "self-hosted, gpu" },
					{ name: "fleet", value: " " },
				],
			}),
		);
		expect(request.inputs.map((input) => [input.key, input.labels])).toEqual([
			["machine", ["self-hosted", "gpu"]],
		]);
	});

	it("round-trips a run through its stored fact field for field", () => {
		const run: InsightRun = {
			id: 9001,
			attempt: 2,
			repository: "octo/app",
			workflow: "CI",
			workflowPath: ".github/workflows/ci.yml",
			event: "pull_request",
			branch: "feat",
			defaultBranch: "main",
			headSha: "0123456789abcdef0123456789abcdef01234567",
			actor: "octocat",
			conclusion: "failure",
			createdAtMs: 1_000,
			completedAtMs: 9_000,
			jobs: [
				{
					id: 7,
					name: "test",
					labels: ["ubuntu-24.04"],
					runnerName: "r1",
					runnerGroup: "Default",
					conclusion: "failure",
					queuedAtMs: 1_000,
					startedAtMs: 2_000,
					completedAtMs: 8_000,
					steps: [
						{
							name: "Set up job",
							number: 1,
							conclusion: "success",
							startedAtMs: 2_000,
							completedAtMs: 2_500,
						},
						{ name: "test", number: 2, conclusion: "failure" },
					],
					needs: ["lint"],
					billed: true,
					relay: true,
				},
				{
					id: 8,
					name: "lint",
					labels: [],
					conclusion: "skipped",
					queuedAtMs: 1_000,
					steps: [],
					billed: false,
				},
			],
			changedPaths: ["src/a.ts"],
			title: "feat: a",
		};
		expect(insightRunOf(runFactOf(run))).toEqual(run);
	});

	it("round-trips provider health through its stored record", () => {
		let health = newProviderHealth();
		for (const atMs of [1_000, 2_000, 3_000])
			health = recordProviderOutcome(health, { atMs, started: false });
		expect(health.trippedAtMs).toBe(3_000);
		const record = providerHealthRecord("depot:depot-ubuntu-24.04", health);
		expect(providerHealthOf(record)).toEqual(health);
		expect(
			providerHealthOf(providerHealthRecord("depot:x", newProviderHealth())),
		).toEqual(newProviderHealth());
	});

	it("gives the walk a machine from its advert and the caller's facts", () => {
		const advert = parseMachineAdvert(fixture("valid/machine.json"));
		const candidate = machineCandidate(advert, {
			online: true,
			ownerCanRead: false,
		});
		expect(candidate).toMatchObject({
			id: "m-1",
			runsOn: "hobo-machine-m-1",
			slots: 2,
			busy: 1,
			sharing: "only_me",
			online: true,
			ownerCanRead: false,
			repository: undefined,
		});
	});

	it("freezes the names every package shares", () => {
		expect(RELAY_LABEL).toBe("hobo-relay");
		expect(DEFAULT_RELAY_JOBS).toEqual({ answer: false, label: "hobo-relay" });
		expect(RELAY_JOB_INPUTS).toEqual([
			"fleet",
			"machine",
			"github",
			...HOSTED_RUNNER_PROVIDERS,
			"size",
			"first",
		]);
		expect(RELAY_JOB_OUTPUTS).toEqual(["runner", "step", "outcome", "reason"]);
		expect(parityTags("R01", "t2")).toEqual(["@parity", "@R01", "@t2"]);
		expect(isRelayCheckStep("Hobo-Labs/hobo/checks/pr-title@v1")).toBe(true);
		expect(isRelayCheckStep("./checks/lint")).toBe(true);
		expect(isRelayCheckStep("actions/checkout@v4")).toBe(false);
	});
});
