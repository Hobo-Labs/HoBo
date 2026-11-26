import { readFileSync } from "node:fs";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	RunnerRouteDecisionSchema,
	type RunnerRouteRequest,
	RunnerRouteRequestSchema,
} from "../src/_generated/runner_route_pb.js";
import {
	DEFAULT_RUNNER_ORDER,
	decideRunnerRoute,
	describeDecision,
	describeSkip,
	type MachineCandidate,
	NO_ROUTE_FACTS,
	noRunnerReason,
	type ParsedRunnerOrder,
	parseRunnerOrder,
	providerHealthKey,
	type RouteFacts,
	RUNNER_SKIP_REASONS,
	type RunnerFleetState,
} from "../src/runner-order/index.js";

const order = (...steps: readonly object[]): ParsedRunnerOrder =>
	parseRunnerOrder(JSON.stringify({ steps }));

function request(
	inputs: Readonly<Record<string, string>>,
	extra: Partial<
		Pick<
			RunnerRouteRequest,
			"private" | "fork" | "actorId" | "triggeringActorId"
		>
	> = {},
): RunnerRouteRequest {
	return create(RunnerRouteRequestSchema, {
		repository: "acme/app",
		private: extra.private ?? true,
		fork: extra.fork ?? false,
		event: "pull_request",
		runId: 9001n,
		runAttempt: 1,
		job: "relay-test",
		actorId: extra.actorId ?? "42",
		triggeringActorId: extra.triggeringActorId ?? "42",
		inputs: Object.entries(inputs).map(([key, labels]) => ({
			key,
			labels: [labels],
		})),
	});
}

function machine(partial: Partial<MachineCandidate> = {}): MachineCandidate {
	return {
		id: "m1",
		name: "studio",
		runsOn: "hobo-local-host",
		labels: ["self-hosted", "macOS", "ARM64"],
		online: true,
		paused: false,
		slots: 1,
		busy: 0,
		sharing: "only_me",
		ownerId: "42",
		ownerCanRead: true,
		lastPickedAtMs: 0,
		repository: undefined,
		...partial,
	};
}

const facts = (partial: Partial<RouteFacts> = {}): RouteFacts => ({
	...NO_ROUTE_FACTS,
	...partial,
});
const fleet = (partial: Partial<RunnerFleetState> = {}): RunnerFleetState => ({
	enabled: true,
	taking: true,
	isolated: false,
	...partial,
});
const reasons = (decision: {
	skipped: readonly { key: string; reason: string }[];
}): string[] => decision.skipped.map((skip) => `${skip.key}:${skip.reason}`);

describe("decideRunnerRoute", () => {
	it.each([
		["unknown runner type", { unknown: "auto" }],
		["empty runner labels", { github: " , " }],
	])("does not widen an explicit relay input with %s", (_name, inputs) => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request(inputs),
			facts({ fleet: fleet() }),
		);
		expect(decision.outcome).toBe("none");
	});
	it("still uses a valid explicit input alongside an unknown input", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ unknown: "auto", github: "ubuntu-24.04" }),
			facts({ fleet: fleet() }),
		);
		expect(decision).toMatchObject({
			outcome: "routed",
			step: "github",
			runner: "ubuntu-24.04",
		});
	});

	it("takes the first step the relay named that can run the job", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted", github: "ubuntu-24.04" }),
			facts({ machines: [machine()] }),
		);
		expect(decision).toMatchObject({
			outcome: "routed",
			runner: "hobo-local-host",
			step: "machine",
			machineId: "m1",
		});
		expect(reasons(decision)).toEqual(["fleet:not_configured"]);
	});

	it("falls through to GitHub-hosted when no machine is connected", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted", github: "ubuntu-24.04" }),
		);
		expect(decision).toMatchObject({
			outcome: "routed",
			runner: "ubuntu-24.04",
			step: "github",
			machineId: "",
		});
		expect(reasons(decision)).toEqual([
			"fleet:not_configured",
			"machine:no_machine",
		]);
	});

	it("never uses a step the relay did not name, and fails with the reason", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted" }),
		);
		expect(decision.outcome).toBe("none");
		expect(decision.runner).toBe("");
		expect(decision.reason).toBe(
			"No runner available. machine: no connected machine has those labels (self-hosted).",
		);
	});

	it("never tries a step the order leaves out, and says so", () => {
		const decision = decideRunnerRoute(
			order({ key: "machine" }),
			request({ machine: "self-hosted", depot: "depot-ubuntu-24.04" }),
		);
		expect(decision.outcome).toBe("none");
		expect(decision.notInOrder).toEqual(["depot"]);
		expect(decision.reason).toContain(
			"Not in the runner order, so never tried: depot.",
		);
	});

	it("keeps machines away from public repositories and forks", () => {
		const machines = [machine({ sharing: "anyone" })];
		const open = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request(
				{ machine: "self-hosted", github: "ubuntu-24.04" },
				{ private: false },
			),
			facts({ machines }),
		);
		expect(open.step).toBe("github");
		expect(reasons(open)).toContain("machine:public_repository");
		const fork = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted" }, { fork: true }),
			facts({ machines }),
		);
		expect(fork.outcome).toBe("none");
		expect(reasons(fork)).toContain("machine:fork_pull_request");
	});

	it("fails closed when the fork fact is missing", () => {
		const missingFork = create(RunnerRouteRequestSchema, {
			repository: "acme/app",
			private: true,
			event: "pull_request",
			runId: 9001n,
			runAttempt: 1,
			job: "relay-test",
			actorId: "42",
			triggeringActorId: "42",
			inputs: [{ key: "machine", labels: ["self-hosted"] }],
		});
		expect(missingFork.fork).toBeUndefined();
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			missingFork,
			facts({ machines: [machine()] }),
		);
		expect(decision.outcome).toBe("none");
		expect(decision.reason).toContain("fork");
		expect(decision.reason).toContain("required");
		expect(decision.skipped).toEqual([]);
	});

	it("lets only an isolated fleet take untrusted code", () => {
		const ask = (
			isolated: boolean,
			extra: Partial<Pick<RunnerRouteRequest, "private" | "fork">>,
		) =>
			decideRunnerRoute(
				DEFAULT_RUNNER_ORDER,
				request({ fleet: "hobo", github: "ubuntu-24.04" }, extra),
				facts({ fleet: fleet({ isolated }) }),
			);
		expect(ask(false, { private: false }).step).toBe("github");
		expect(reasons(ask(false, { fork: true }))).toEqual([
			"fleet:needs_isolation",
			"machine:not_configured",
		]);
		expect(ask(true, { private: false })).toMatchObject({
			outcome: "routed",
			runner: "hobo",
			step: "fleet",
		});
		expect(ask(false, {}).step).toBe("fleet");
	});

	it("skips a fleet that does not serve the repository", () => {
		const off = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ fleet: "hobo" }),
			facts({ fleet: fleet({ enabled: false }) }),
		);
		expect(reasons(off)).toContain("fleet:fleet_off");
		expect(
			reasons(
				decideRunnerRoute(DEFAULT_RUNNER_ORDER, request({ fleet: "hobo" })),
			),
		).toContain("fleet:fleet_off");
	});

	it("queues on a busy fleet or machine only when nothing later takes the job", () => {
		const busyFleet = facts({ fleet: fleet({ taking: false }) });
		expect(
			decideRunnerRoute(
				DEFAULT_RUNNER_ORDER,
				request({ fleet: "hobo-trunk", github: "ubuntu-24.04" }),
				busyFleet,
			).step,
		).toBe("github");
		const waitingFleet = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ fleet: "hobo-trunk" }),
			busyFleet,
		);
		expect(waitingFleet).toMatchObject({
			outcome: "waiting",
			runner: "hobo-trunk",
			step: "fleet",
		});
		const waitingMachine = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted" }),
			facts({ machines: [machine({ busy: 1 })] }),
		);
		expect(waitingMachine).toMatchObject({
			outcome: "waiting",
			runner: "hobo-local-host",
			step: "machine",
			machineId: "m1",
		});
		expect(reasons(waitingMachine)).toContain("machine:machine_full");
	});

	it("waits on the first busy step in order, not the last", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ fleet: "hobo", machine: "self-hosted" }),
			facts({
				fleet: fleet({ taking: false }),
				machines: [machine({ busy: 1 })],
			}),
		);
		expect(decision).toMatchObject({ outcome: "waiting", step: "fleet" });
	});

	it("fails fast for a paused or unshared machine instead of queueing", () => {
		const paused = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted" }),
			facts({ machines: [machine({ paused: true })] }),
		);
		expect(paused.outcome).toBe("none");
		expect(paused.reason).toContain("machine: the machine is paused (studio)");
		const unshared = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted" }, { actorId: "7" }),
			facts({ machines: [machine()] }),
		);
		expect(reasons(unshared)).toContain("machine:machine_not_shared");
	});

	it("applies the included-minutes limit and runway to a limited github step", () => {
		const limited = order(
			{ key: "github", minutesLimitPercent: 80 },
			{ key: "depot" },
		);
		const ask = (usedMinutes: number, burnPerHour?: number) =>
			decideRunnerRoute(
				limited,
				request({ github: "ubuntu-24.04", depot: "depot-ubuntu-24.04" }),
				facts({
					minutes:
						burnPerHour === undefined
							? { usedMinutes, includedMinutes: 2000 }
							: { usedMinutes, includedMinutes: 2000, burnPerHour },
				}),
			);
		expect(ask(1599).step).toBe("github");
		const over = ask(1600);
		expect(over.step).toBe("depot");
		expect(over.skipped[0]).toMatchObject({
			key: "github",
			reason: "minutes_limit",
			detail: "1600 of 2000 included minutes used; the limit is 80%",
		});
		expect(reasons(ask(1000, 301))).toEqual(["github:minutes_runway"]);
		expect(ask(1000, 300).step).toBe("github");

		const unknown = decideRunnerRoute(
			limited,
			request({ github: "ubuntu-24.04" }),
		);
		expect(unknown.outcome).toBe("none");
		expect(unknown.skipped[0]).toMatchObject({
			key: "github",
			reason: "minutes_limit",
			detail: "minutes usage is unknown; the limit is 80%",
		});
	});

	it("uses the unlimited github step after the limited one refuses", () => {
		const decision = decideRunnerRoute(
			order(
				{ key: "github", minutesLimitPercent: 50 },
				{ key: "machine" },
				{ key: "github" },
			),
			request({ machine: "self-hosted", github: "ubuntu-24.04" }),
			facts({ minutes: { usedMinutes: 1500, includedMinutes: 2000 } }),
		);
		expect(decision).toMatchObject({ outcome: "routed", step: "github" });
		expect(reasons(decision)).toEqual([
			"github:minutes_limit",
			"machine:no_machine",
		]);
	});

	it("applies a monthly spend limit to a hosted provider", () => {
		const capped = order(
			{ key: "blacksmith", spendLimitUsd: 100 },
			{ key: "github" },
		);
		const ask = (spent: number | undefined) =>
			decideRunnerRoute(
				capped,
				request({
					blacksmith: "blacksmith-4vcpu-ubuntu-2404",
					github: "ubuntu-24.04",
				}),
				facts({
					spendUsd:
						spent === undefined ? new Map() : new Map([["blacksmith", spent]]),
				}),
			);
		expect(ask(99.99).step).toBe("blacksmith");
		const unknown = ask(undefined);
		expect(unknown.step).toBe("github");
		expect(unknown.skipped[0]).toMatchObject({
			key: "blacksmith",
			reason: "spend_limit",
			detail: "spend is unknown; the limit is $100",
		});
		const over = ask(100);
		expect(over.step).toBe("github");
		expect(over.skipped[0]?.detail).toBe("$100.00 of $100 spent this month");
	});

	it("refuses a hosted step given another provider's label or several labels", () => {
		const hosted = order({ key: "depot" }, { key: "github" });
		const wrong = decideRunnerRoute(
			hosted,
			request({ depot: "blacksmith-2vcpu-ubuntu-2404" }),
		);
		expect(wrong.skipped[0]).toMatchObject({
			reason: "not_provider_label",
			detail: "blacksmith-2vcpu-ubuntu-2404",
		});
		const many = decideRunnerRoute(
			hosted,
			request({
				depot: "depot-ubuntu-24.04, depot-ubuntu-24.04-4",
				github: "ubuntu-24.04, ubuntu-22.04",
			}),
		);
		expect(reasons(many)).toEqual([
			"depot:too_many_labels",
			"github:too_many_labels",
		]);
		expect(many.outcome).toBe("none");
	});

	it.each([
		["self-hosted", { private: false }],
		["self-hosted", { fork: true }],
		["department-runner", { private: false }],
		["department-runner", { fork: true }],
		["department-runner", {}],
	])("refuses GitHub routing to %s for %j", (label, extra) => {
		const decision = decideRunnerRoute(
			order({ key: "github" }),
			request({ github: label }, extra),
		);
		expect(decision.outcome).toBe("none");
		expect(decision.skipped).toEqual([
			expect.objectContaining({
				key: "github",
				reason: "not_provider_label",
				detail: label,
			}),
		]);
	});

	it("keeps providers off public repositories unless allowed or opted in", () => {
		const hosted = order(
			{ key: "depot" },
			{ key: "namespace" },
			{ key: "blacksmith" },
		);
		const ask = (publicOptIn: ReadonlySet<"depot" | "namespace">) =>
			decideRunnerRoute(
				hosted,
				request(
					{
						depot: "depot-ubuntu-24.04",
						namespace: "nscloud-ubuntu-24.04-amd64-2x4",
						blacksmith: "blacksmith-2vcpu-ubuntu-2404",
					},
					{ private: false },
				),
				facts({ publicOptIn }),
			);
		const closed = ask(new Set());
		expect(closed.step).toBe("blacksmith");
		expect(reasons(closed)).toEqual([
			"depot:public_repository",
			"namespace:public_repository",
		]);
		expect(ask(new Set(["depot"])).step).toBe("depot");
		expect(ask(new Set(["namespace"])).step).toBe("namespace");
	});

	it("keeps hosted providers away from forks", () => {
		const decision = decideRunnerRoute(
			order({ key: "depot" }, { key: "github" }),
			request(
				{ depot: "depot-ubuntu-24.04", github: "ubuntu-24.04" },
				{ fork: true },
			),
		);
		expect(decision.step).toBe("github");
		expect(reasons(decision)).toEqual(["depot:fork_pull_request"]);
	});

	it("omits auto inputs for sizes nobody has", () => {
		const sized = parseRunnerOrder(
			JSON.stringify({
				steps: [{ key: "github" }, { key: "ubicloud" }, { key: "depot" }],
				autoSizeVcpus: 32,
			}),
		);
		const decision = decideRunnerRoute(
			sized,
			request({ github: "auto", ubicloud: "auto", depot: "auto" }),
		);
		expect(decision).toMatchObject({
			outcome: "routed",
			runner: "depot-ubuntu-24.04-32",
			step: "depot",
		});
		expect(reasons(decision)).toEqual([
			"github:not_configured",
			"ubicloud:not_configured",
		]);
	});

	it("routes a relay with no inputs to any step at the default size", () => {
		const decision = decideRunnerRoute(
			order({ key: "runs-on" }, { key: "github" }),
			request({}),
		);
		expect(decision).toMatchObject({
			outcome: "routed",
			runner: "runs-on=9001/runner=2cpu-linux-x64",
			step: "runs-on",
		});
		expect(decision.notInOrder).toEqual([]);
	});

	it("passes over an unhealthy runner type, then uses it when nothing else can", () => {
		const hosted = order({ key: "depot" }, { key: "github" });
		const unhealthy = new Set([
			providerHealthKey("depot", "Depot-Ubuntu-24.04"),
		]);
		const withFallback = decideRunnerRoute(
			hosted,
			request({ depot: "depot-ubuntu-24.04", github: "ubuntu-24.04" }),
			facts({ unhealthy }),
		);
		expect(withFallback).toMatchObject({
			step: "github",
			unhealthyFallback: false,
		});
		expect(reasons(withFallback)).toEqual(["depot:provider_unhealthy"]);
		const alone = decideRunnerRoute(
			hosted,
			request({ depot: "depot-ubuntu-24.04" }),
			facts({ unhealthy }),
		);
		expect(alone).toMatchObject({
			outcome: "routed",
			runner: "depot-ubuntu-24.04",
			step: "depot",
			unhealthyFallback: true,
		});
		expect(describeDecision(alone)).toContain("failing to start jobs");
	});

	it("prefers waiting for a full machine over an unhealthy runner", () => {
		const decision = decideRunnerRoute(
			order({ key: "machine" }, { key: "depot" }),
			request({ machine: "self-hosted", depot: "depot-ubuntu-24.04" }),
			facts({
				machines: [machine({ busy: 1 })],
				unhealthy: new Set([providerHealthKey("depot", "depot-ubuntu-24.04")]),
			}),
		);
		expect(decision).toMatchObject({
			outcome: "waiting",
			step: "machine",
			unhealthyFallback: false,
		});
	});

	it("ignores health when the order turns skipping off", () => {
		const decision = decideRunnerRoute(
			parseRunnerOrder(
				'{"steps":[{"key":"depot"},{"key":"github"}],"skipUnhealthy":false}',
			),
			request({ depot: "depot-ubuntu-24.04", github: "ubuntu-24.04" }),
			facts({
				unhealthy: new Set([providerHealthKey("depot", "depot-ubuntu-24.04")]),
			}),
		);
		expect(decision).toMatchObject({ step: "depot", unhealthyFallback: false });
	});

	it("tries a job's preferred runner type first", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted", github: "ubuntu-24.04" }),
			facts({ machines: [machine()], first: "github" }),
		);
		expect(decision.step).toBe("github");
	});

	it("sends a retry to the same or to another runner", () => {
		const machines = [
			machine({ id: "a", name: "a", runsOn: "host-a", lastPickedAtMs: 1 }),
			machine({ id: "b", name: "b", runsOn: "host-b", lastPickedAtMs: 2 }),
		];
		const ask = (target: "same" | "other" | "any", failedMachineId: string) =>
			decideRunnerRoute(
				order({ key: "github" }, { key: "machine" }),
				request({ machine: "self-hosted", github: "ubuntu-24.04" }),
				facts({
					machines,
					retry: { target, failedStep: "machine", failedMachineId },
				}),
			);
		expect(ask("same", "b")).toMatchObject({ step: "machine", machineId: "b" });
		expect(ask("any", "b").step).toBe("github");
		const other = decideRunnerRoute(
			order({ key: "machine" }),
			request({ machine: "self-hosted" }),
			facts({
				machines,
				retry: { target: "other", failedStep: "machine", failedMachineId: "a" },
			}),
		);
		expect(other.machineId).toBe("b");
	});

	it("produces decisions the schema fixtures describe", () => {
		const decision = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ machine: "self-hosted", github: "ubuntu-24.04" }),
			facts({ machines: [machine({ paused: true })] }),
		);
		const json = JSON.parse(toJsonString(RunnerRouteDecisionSchema, decision));
		expect(json).toEqual({
			outcome: "routed",
			runner: "ubuntu-24.04",
			step: "github",
			skipped: [
				{ key: "fleet", reason: "not_configured" },
				{ key: "machine", reason: "machine_paused", detail: "studio" },
			],
		});
		for (const name of [
			"decision-routed",
			"decision-waiting",
			"decision-none",
		]) {
			const stored = fromJsonString(
				RunnerRouteDecisionSchema,
				readFileSync(
					new URL(
						`../data-models/fixtures/runner_route/valid/${name}.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			expect(describeDecision(stored).length).toBeGreaterThan(0);
		}
	});

	it("answers the request fixture", () => {
		const stored = fromJsonString(
			RunnerRouteRequestSchema,
			readFileSync(
				new URL(
					"../data-models/fixtures/runner_route/valid/request.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const decision = decideRunnerRoute(
			order({ key: "machine" }, { key: "runs-on" }, { key: "github" }),
			stored,
		);
		expect(decision).toMatchObject({
			outcome: "routed",
			runner: "runs-on=9001/runner=2cpu-linux-x64",
			step: "runs-on",
		});
	});
});

describe("decision text", () => {
	it("has wording for every skip reason", () => {
		for (const reason of RUNNER_SKIP_REASONS) {
			const text = describeSkip({
				$typeName: "hobo.ci.v1.RunnerRouteSkip",
				key: "depot",
				reason,
				detail: "",
			});
			expect(text.startsWith("depot: ")).toBe(true);
			expect(text).not.toContain(reason);
		}
	});

	it("says so when the order and the relay share no step", () => {
		expect(noRunnerReason([], [])).toBe(
			"No runner available. the runner order and the relay name no step in common.",
		);
	});

	it("describes each outcome in one line", () => {
		const routed = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ github: "ubuntu-24.04" }),
		);
		expect(describeDecision(routed)).toBe("Routed to ubuntu-24.04 (github).");
		const waiting = decideRunnerRoute(
			DEFAULT_RUNNER_ORDER,
			request({ fleet: "hobo" }),
			facts({ fleet: fleet({ taking: false }) }),
		);
		expect(describeDecision(waiting)).toBe(
			"Queued on hobo (fleet): every runner that fits is busy.",
		);
	});
});
