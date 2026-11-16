import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { RunnerRetryPolicySchema } from "../src/_generated/runner_route_pb.js";
import {
	admits,
	chooseMachine,
	type FailedJob,
	isProviderMiss,
	MACHINE_DISCONNECT_SLACK_MS,
	type MachineCandidate,
	type MachineWant,
	machineLabels,
	minutesVerdict,
	newProviderHealth,
	PROVIDER_HEALTH_DEFAULTS,
	type ProviderHealth,
	providerHealthKey,
	providerHealthState,
	RUNNER_RETRY_DAILY_CAP,
	recordProviderOutcome,
	retryKind,
	retryVerdict,
	spendVerdict,
	startProviderTrial,
} from "../src/runner-order/index.js";

function machine(partial: Partial<MachineCandidate> = {}): MachineCandidate {
	return {
		id: "m1",
		name: "studio",
		runsOn: "host-m1",
		labels: machineLabels("macos", "arm64"),
		online: true,
		paused: false,
		slots: 1,
		busy: 0,
		sharing: "anyone",
		ownerId: "42",
		ownerCanRead: true,
		lastPickedAtMs: 0,
		repository: undefined,
		...partial,
	};
}

function want(partial: Partial<MachineWant> = {}): MachineWant {
	return {
		labels: ["self-hosted"],
		repository: "acme/app",
		starterId: "42",
		triggeredById: "42",
		preferMachineId: undefined,
		avoidMachineId: undefined,
		...partial,
	};
}

const chosen = (
	candidates: readonly MachineCandidate[],
	wanted: MachineWant = want(),
): string => {
	const choice = chooseMachine(candidates, wanted);
	return choice.kind === "machine" ? choice.machine.id : choice.reason;
};

describe("chooseMachine", () => {
	it("labels a machine by what it is", () => {
		expect(machineLabels("linux", "x64")).toEqual([
			"self-hosted",
			"Linux",
			"X64",
		]);
		expect(machineLabels("windows", "arm")).toEqual([
			"self-hosted",
			"Windows",
			"ARM",
		]);
	});

	it("needs every wanted label, ignoring case, on an online machine", () => {
		expect(
			chosen([machine()], want({ labels: ["SELF-HOSTED", "macos"] })),
		).toBe("m1");
		expect(
			chosen([machine()], want({ labels: ["self-hosted", "Linux"] })),
		).toBe("no_machine");
		expect(chosen([machine({ online: false })])).toBe("no_machine");
		expect(chosen([])).toBe("no_machine");
	});

	it("keeps a repository runner to its own repository", () => {
		expect(chosen([machine({ repository: "Acme/App" })])).toBe("m1");
		expect(chosen([machine({ repository: "acme/other" })])).toBe("no_machine");
	});

	it("lets an only-me machine run only what its owner started and triggered", () => {
		const mine = machine({ sharing: "only_me" });
		expect(admits(mine, want())).toBe(true);
		expect(admits(mine, want({ triggeredById: "7" }))).toBe(false);
		expect(admits(mine, want({ starterId: "7" }))).toBe(false);
		expect(admits(mine, want({ starterId: undefined }))).toBe(false);
		expect(chosen([mine], want({ starterId: "7" }))).toBe("machine_not_shared");
	});

	it("lets a shared machine run others' jobs only where its owner can read", () => {
		expect(admits(machine(), want({ starterId: "7" }))).toBe(true);
		expect(
			admits(machine({ ownerCanRead: false }), want({ starterId: "7" })),
		).toBe(false);
		// The owner's own job needs no second check.
		expect(admits(machine({ ownerCanRead: false }), want())).toBe(true);
	});

	it("names the last gate anything reached", () => {
		const paused = chooseMachine([machine({ paused: true })], want());
		expect(paused).toMatchObject({
			kind: "none",
			reason: "machine_paused",
			machine: { id: "m1" },
		});
		const full = chooseMachine(
			[machine({ busy: 1 }), machine({ id: "m2", paused: true })],
			want(),
		);
		expect(full).toMatchObject({
			kind: "none",
			reason: "machine_full",
			machine: { id: "m1" },
		});
		expect(
			chosen([
				machine({ id: "a", sharing: "only_me", ownerId: "9" }),
				machine({ id: "b", paused: true }),
			]),
		).toBe("machine_paused");
	});

	it("counts slots", () => {
		expect(chosen([machine({ slots: 2, busy: 1 })])).toBe("m1");
		expect(chosen([machine({ slots: 2, busy: 2 })])).toBe("machine_full");
	});

	it("prefers the starter's own machine, then the least recently picked", () => {
		const candidates = [
			machine({ id: "theirs", ownerId: "9", lastPickedAtMs: 1 }),
			machine({ id: "mine-recent", lastPickedAtMs: 50 }),
			machine({ id: "mine-idle", lastPickedAtMs: 10 }),
		];
		expect(chosen(candidates)).toBe("mine-idle");
		expect(chosen(candidates, want({ starterId: "7" }))).toBe("theirs");
		// Equal on everything else: the id decides, so the answer is stable.
		expect(chosen([machine({ id: "b" }), machine({ id: "a" })], want())).toBe(
			"a",
		);
	});

	it("puts a retry's machine first or last", () => {
		const candidates = [
			machine({ id: "a", lastPickedAtMs: 1 }),
			machine({ id: "b", lastPickedAtMs: 2 }),
		];
		expect(chosen(candidates, want({ preferMachineId: "b" }))).toBe("b");
		expect(chosen(candidates, want({ avoidMachineId: "a" }))).toBe("b");
		// The avoided machine still takes the job when it is the only one.
		expect(chosen([machine({ id: "a" })], want({ avoidMachineId: "a" }))).toBe(
			"a",
		);
	});
});

describe("limits", () => {
	it("allows when usage is unmeasured or the plan includes nothing", () => {
		expect(minutesVerdict(80, undefined)).toEqual({ allowed: true });
		expect(minutesVerdict(80, { usedMinutes: 10, includedMinutes: 0 })).toEqual(
			{ allowed: true },
		);
	});

	it("refuses at the limit, not before", () => {
		expect(
			minutesVerdict(80, { usedMinutes: 2399, includedMinutes: 3000 }).allowed,
		).toBe(true);
		expect(
			minutesVerdict(80, { usedMinutes: 2400, includedMinutes: 3000 }),
		).toMatchObject({ allowed: false, reason: "minutes_limit" });
		expect(
			minutesVerdict(100, { usedMinutes: 3000, includedMinutes: 3000 }).allowed,
		).toBe(false);
	});

	it("keeps two hours of burn in reserve", () => {
		const usage = (burnPerHour: number) => ({
			usedMinutes: 1000,
			includedMinutes: 2000,
			burnPerHour,
		});
		expect(minutesVerdict(100, usage(500)).allowed).toBe(true);
		expect(minutesVerdict(100, usage(501))).toMatchObject({
			allowed: false,
			reason: "minutes_runway",
			detail: "1000 included minutes left at 501 a hour",
		});
		expect(minutesVerdict(100, usage(0)).allowed).toBe(true);
	});

	it("refuses a provider at its monthly spend, not before", () => {
		expect(spendVerdict(50, undefined)).toEqual({ allowed: true });
		expect(spendVerdict(50, 49.99)).toEqual({ allowed: true });
		expect(spendVerdict(50, 50)).toEqual({
			allowed: false,
			reason: "spend_limit",
			detail: "$50.00 of $50 spent this month",
		});
	});
});

describe("provider health", () => {
	const minute = 60_000;
	const misses = (times: readonly number[]): ProviderHealth =>
		times.reduce(
			(health, atMs) => recordProviderOutcome(health, { atMs, started: false }),
			newProviderHealth(),
		);

	it("keys a runner type by provider and lower-case label", () => {
		expect(providerHealthKey("depot", " Depot-Ubuntu-24.04 ")).toBe(
			"depot:depot-ubuntu-24.04",
		);
	});

	it("stays healthy until three misses in a row inside the window", () => {
		expect(providerHealthState(newProviderHealth(), 0)).toBe("healthy");
		expect(providerHealthState(misses([0, minute]), 2 * minute)).toBe(
			"healthy",
		);
		const tripped = misses([0, minute, 2 * minute]);
		expect(tripped.trippedAtMs).toBe(2 * minute);
		expect(providerHealthState(tripped, 3 * minute)).toBe("unhealthy");
	});

	it("does not trip on misses spread wider than the window", () => {
		const spread = misses([0, 20 * minute, 31 * minute]);
		expect(spread.trippedAtMs).toBeUndefined();
		// The window slides: the next miss makes three inside thirty minutes.
		expect(
			recordProviderOutcome(spread, { atMs: 40 * minute, started: false })
				.trippedAtMs,
		).toBe(40 * minute);
		expect(misses([0, 15 * minute, 30 * minute]).trippedAtMs).toBe(30 * minute);
	});

	it("clears on any start", () => {
		const cleared = recordProviderOutcome(misses([0, 1, 2]), {
			atMs: 3,
			started: true,
		});
		expect(cleared).toEqual(newProviderHealth());
		expect(
			recordProviderOutcome(misses([0, 1]), { atMs: 2, started: true })
				.outcomes,
		).toEqual([]);
	});

	it("allows one trial after the back-off, and waits on it", () => {
		const tripped = misses([0, 1, 2]);
		expect(providerHealthState(tripped, 2 + 10 * minute - 1)).toBe("unhealthy");
		expect(providerHealthState(tripped, 2 + 10 * minute)).toBe("trial");
		const trying = startProviderTrial(tripped, 2 + 10 * minute);
		expect(providerHealthState(trying, 2 + 11 * minute)).toBe("unhealthy");
		// A trial nobody reported on expires and another is allowed.
		expect(providerHealthState(trying, 2 + 40 * minute)).toBe("trial");
	});

	it("doubles the back-off on a failed trial, up to the ceiling", () => {
		let health = misses([0, 1, 2]);
		const backoffs: number[] = [];
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const due = health.nextTrialAtMs ?? 0;
			health = recordProviderOutcome(startProviderTrial(health, due), {
				atMs: due + minute,
				started: false,
			});
			backoffs.push(health.backoffMs / minute);
			expect(health.trialStartedAtMs).toBeUndefined();
			expect(health.nextTrialAtMs).toBe(due + minute + health.backoffMs);
		}
		expect(backoffs).toEqual([20, 40, 60, 60]);
		expect(health.trippedAtMs).toBe(2);
	});

	it("counts a job as missed once it has waited the limit", () => {
		const limit = PROVIDER_HEALTH_DEFAULTS.missedAfterMs;
		expect(isProviderMiss(0, limit - 1)).toBe(false);
		expect(isProviderMiss(0, limit)).toBe(true);
	});
});

describe("retries", () => {
	const job = (partial: Partial<FailedJob> = {}): FailedJob => ({
		ranSteps: true,
		startedAtMs: 1000,
		completedAtMs: 5000,
		annotations: [],
		machineDisconnects: [],
		...partial,
	});
	const policy = (
		partial: { enabled?: boolean; runner?: string; max?: number } = {},
	) =>
		create(RunnerRetryPolicySchema, {
			enabled: true,
			runner: "other",
			max: 1,
			...partial,
		});
	const failure = (
		partial: Partial<Parameters<typeof retryVerdict>[1]> = {},
	) => ({
		job: job({ ranSteps: false }),
		relaysInRun: 1,
		retriesThisRun: 0,
		retriesToday: 0,
		...partial,
	});

	it("classifies a failure that was not the job's own", () => {
		expect(retryKind(job({ ranSteps: false }))).toBe("runner_start");
		expect(retryKind(job({ machineDisconnects: [1000] }))).toBe("machine_lost");
		expect(
			retryKind(
				job({ machineDisconnects: [5000 + MACHINE_DISCONNECT_SLACK_MS] }),
			),
		).toBe("machine_lost");
		expect(
			retryKind(
				job({ machineDisconnects: [5001 + MACHINE_DISCONNECT_SLACK_MS] }),
			),
		).toBeUndefined();
		expect(retryKind(job({ machineDisconnects: [999] }))).toBeUndefined();
		expect(
			retryKind(
				job({
					annotations: [
						"The self-hosted runner lost communication with the server.",
					],
				}),
			),
		).toBe("runner_lost");
		expect(
			retryKind(
				job({ annotations: ["The runner has received a shutdown signal."] }),
			),
		).toBe("runner_lost");
		expect(
			retryKind(job({ annotations: ["Process completed with exit code 1."] })),
		).toBeUndefined();
		expect(
			retryKind(job({ completedAtMs: undefined, machineDisconnects: [2000] })),
		).toBeUndefined();
	});

	it("retries once within the policy and the caps", () => {
		expect(retryVerdict(policy(), failure())).toEqual({
			retry: true,
			kind: "runner_start",
			target: "other",
		});
		expect(retryVerdict(policy({ enabled: false }), failure())).toEqual({
			retry: false,
			reason: "off",
		});
		expect(retryVerdict(policy(), failure({ job: job() }))).toEqual({
			retry: false,
			reason: "own_failure",
		});
		expect(retryVerdict(policy(), failure({ relaysInRun: 2 }))).toEqual({
			retry: false,
			reason: "several_relays",
		});
		expect(retryVerdict(policy(), failure({ retriesThisRun: 1 }))).toEqual({
			retry: false,
			reason: "run_limit",
		});
		expect(
			retryVerdict(policy({ max: 2 }), failure({ retriesThisRun: 1 })).retry,
		).toBe(true);
		expect(
			retryVerdict(
				policy(),
				failure({ retriesToday: RUNNER_RETRY_DAILY_CAP - 1 }),
			).retry,
		).toBe(true);
		expect(
			retryVerdict(policy(), failure({ retriesToday: RUNNER_RETRY_DAILY_CAP })),
		).toEqual({ retry: false, reason: "daily_limit" });
		expect(
			retryVerdict(policy({ runner: "sideways" }), failure()),
		).toMatchObject({ target: "any" });
	});
});
