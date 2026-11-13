import type { JsonObject } from "@bufbuild/protobuf";
import { type BudgetPolicy, parseBudgetPolicy } from "@hobo/core";
import { isQuoteVector, QuoteEngine } from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import {
	balanceFleet,
	FLEET_PROVIDER_KINDS,
	type FleetBalanceInput,
	type FleetDemand,
	type FleetMemberState,
	fleetRoutesVariableValue,
	fleetRouteTable,
	RUNNER_FINANCIAL_MODELS,
	type RunnerModelId,
	runnerFinancialModel,
	runnerQuoteScenario,
} from "../src/fleet/index.js";

const NOW = "2026-11-10T00:00:00Z";

function policy(
	overrides: JsonObject = {},
	constraints: readonly JsonObject[] = [],
): BudgetPolicy {
	return parseBudgetPolicy({
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "hobo-labs",
		budgetId: "ci",
		periodId: "2026-11",
		revision: "fleet-001",
		workloads: ["ci"],
		currency: "USD",
		limitMicros: 50_000_000,
		objective: "min-cost",
		enforcement: "conservative",
		periodKind: "manual",
		constraints: [...constraints],
		...overrides,
	});
}

function member(
	id: RunnerModelId,
	overrides: Partial<FleetMemberState> = {},
): FleetMemberState {
	const model = runnerFinancialModel(id);
	if (!model) throw new Error(`no model ${id}`);
	return {
		model,
		enabled: true,
		activeJobs: 0,
		healthy: true,
		commercial: { subscribed: true },
		payer: model.provider,
		payerExposureMicros: 0,
		...overrides,
	};
}

const PUBLIC_ORG_PR: FleetDemand = {
	id: "Hobo-Labs/HoBo:1:2:1",
	minutes: 10,
	repository: { visibility: "public", ownerType: "organization" },
	forkPullRequest: false,
	needsDocker: true,
	isolationRequired: false,
};

function balance(
	members: readonly FleetMemberState[],
	overrides: Partial<FleetBalanceInput> = {},
) {
	return balanceFleet({
		members,
		demand: PUBLIC_ORG_PR,
		policy: policy(),
		exposureMicros: 0,
		activeWork: 0,
		now: NOW,
		allowNewProviderAgreements: false,
		...overrides,
	});
}

function quote(
	id: RunnerModelId,
	minutes: number,
	state: { subscribed: boolean; allowanceRemainingMinutes?: string } = {
		subscribed: true,
	},
	at = NOW,
) {
	const model = runnerFinancialModel(id);
	if (!model) throw new Error(`no model ${id}`);
	return QuoteEngine.quote(
		runnerQuoteScenario({ model, state, tenantId: "hobo-labs", minutes, at }),
	);
}

function billed(...args: Parameters<typeof quote>): string {
	const result = quote(...args);
	if (!isQuoteVector(result)) throw new Error(`${result.code}`);
	return result.incremental?.billed?.decimal ?? "";
}

describe("runner financial models", () => {
	it("cover every provider the fleet is asked to draw on", () => {
		expect(FLEET_PROVIDER_KINDS).toEqual([
			"agent37",
			"blacksmith",
			"blaxel",
			"boat",
			"cloudflare-sandbox",
			"daytona",
			"depot",
			"e2b",
			"freestyle",
			"github",
			"hobo-box-worker",
			"jog",
			"kubernetes",
			"lizard",
			"local",
			"modal",
			"northflank",
			"runloop",
		]);
	});

	it("carry a source, a read date and a later expiry for every price", () => {
		for (const model of RUNNER_FINANCIAL_MODELS) {
			expect(model.evidence.source, model.id).toMatch(/^https:\/\//);
			expect(Date.parse(model.evidence.validUntil), model.id).toBeGreaterThan(
				Date.parse(model.evidence.observedAt),
			);
			expect(model.evidence.note.length, model.id).toBeGreaterThan(20);
		}
	});

	it("record documented limits that agree with the machine they price", () => {
		const read: string[] = [];
		for (const { id } of RUNNER_FINANCIAL_MODELS) {
			const model = runnerFinancialModel(id);
			const limits = model?.capabilities;
			if (!model || !limits) continue;
			read.push(id);
			expect(limits.source, id).toMatch(/^https:\/\//);
			if (limits.maxRuntimeMinutes !== undefined)
				expect(limits.maxRuntimeMinutes, id).toBeGreaterThan(0);
			// The priced class cannot be larger than the provider's largest.
			if (limits.maxMachine) {
				expect(model.machine.vcpus, id).toBeLessThanOrEqual(
					limits.maxMachine.vcpus,
				);
				expect(model.machine.memoryGb, id).toBeLessThanOrEqual(
					limits.maxMachine.memoryGb,
				);
			}
			// Only a machine with its own kernel is a machine of its own.
			if (model.eligibility.isolated) expect(limits.isolation, id).toBe("vm");
		}
		expect(read).toEqual(
			expect.arrayContaining([
				"daytona-vm-4vcpu",
				"e2b-hobby-4vcpu",
				"lizard-runner-4vcpu",
			]),
		);
	});

	it("are all priced by the quote engine without rejection", () => {
		for (const model of RUNNER_FINANCIAL_MODELS)
			for (const subscribed of [true, false]) {
				const result = QuoteEngine.quote(
					runnerQuoteScenario({
						model,
						state: { subscribed },
						tenantId: "hobo-labs",
						minutes: 10,
						at: NOW,
					}),
				);
				expect(isQuoteVector(result), `${model.id} ${subscribed}`).toBe(true);
			}
	});

	it("price ten minutes at each provider's published rate", () => {
		expect(billed("hobo-box", 10)).toBe("0");
		expect(billed("github-hosted-public", 10)).toBe("0");
		expect(billed("github-hosted-private", 10)).toBe("0.06");
		expect(billed("boat", 10)).toBe("0.006");
		expect(billed("agent37-vm-4vcpu", 10)).toBe("0.00522");
		expect(billed("modal-sandbox-4vcpu", 10)).toBe("0.07932");
	});

	it("charge nothing while included minutes remain, then the overage", () => {
		expect(billed("blacksmith-4vcpu", 10)).toBe("0");
		expect(
			billed("blacksmith-4vcpu", 10, {
				subscribed: true,
				allowanceRemainingMinutes: "4",
			}),
		).toBe("0.048");
		expect(
			billed("jog-4vcpu", 10, {
				subscribed: true,
				allowanceRemainingMinutes: "0",
			}),
		).toBe("0.024");
		expect(
			billed("depot-4vcpu", 10, {
				subscribed: true,
				allowanceRemainingMinutes: "0",
			}),
		).toBe("0.12");
	});

	it("count the plan fee as the job's cost only when the job opens the plan", () => {
		expect(billed("boat", 10, { subscribed: true })).toBe("0.006");
		expect(billed("boat", 10, { subscribed: false })).toBe("20.006");
		expect(billed("depot-4vcpu", 10, { subscribed: false })).toBe("20");
	});

	it("refuse a price read too long ago", () => {
		const result = quote(
			"boat",
			10,
			{ subscribed: true },
			"2027-03-01T00:00:00Z",
		);
		expect(isQuoteVector(result)).toBe(false);
	});
});

describe("fleet eligibility", () => {
	const all = RUNNER_FINANCIAL_MODELS.map((model) => member(model.id));
	const refusal = (
		result: ReturnType<typeof balance>,
		id: RunnerModelId,
	): string | undefined =>
		result.refusals.find((entry) => entry.memberId === id)?.code;

	it("keeps providers that do not serve public repositories off a public one", () => {
		const result = balance(all);
		expect(refusal(result, "jog-4vcpu")).toBe("fleet.visibility");
		expect(refusal(result, "github-hosted-private")).toBe("fleet.visibility");
		// Off until the owner turns public repositories on at the provider.
		expect(refusal(result, "boat")).toBe("fleet.visibility");
		expect(refusal(result, "depot-4vcpu")).toBe("fleet.visibility");
		expect(
			refusal(
				balance([member("boat", { publicRepositoriesEnabled: true })]),
				"boat",
			),
		).toBeUndefined();
	});

	it("serves a private repository with the private GitHub price, not the free one", () => {
		const result = balance(all, {
			demand: {
				...PUBLIC_ORG_PR,
				repository: { visibility: "private", ownerType: "organization" },
			},
		});
		expect(refusal(result, "github-hosted-public")).toBe("fleet.visibility");
		expect(refusal(result, "jog-4vcpu")).toBeUndefined();
	});

	it("applies ownership, Docker and fork rules", () => {
		const personal = balance(all, {
			demand: {
				...PUBLIC_ORG_PR,
				repository: { visibility: "public", ownerType: "user" },
			},
		});
		expect(refusal(personal, "blacksmith-4vcpu")).toBe(
			"fleet.organization-only",
		);
		expect(refusal(balance(all), "agent-box")).toBe("fleet.docker");
		const fork = balance(all, {
			demand: { ...PUBLIC_ORG_PR, needsDocker: false, forkPullRequest: true },
		});
		expect(refusal(fork, "agent-box")).toBe("fleet.fork");
		expect(refusal(fork, "blacksmith-4vcpu")).toBe("fleet.fork");
		expect(refusal(fork, "hobo-box")).toBeUndefined();
	});

	it("lets only members serving its label reach a job that is already queued", () => {
		const result = balance(all, {
			demand: { ...PUBLIC_ORG_PR, queuedOnLabel: "hobo" },
		});
		expect(refusal(result, "github-hosted-public")).toBe("fleet.label-bound");
		expect(refusal(result, "blacksmith-4vcpu")).toBe("fleet.label-bound");
		expect(result.ranking.every((choice) => choice.binding === "inject")).toBe(
			true,
		);
	});

	it("keeps a job that needs its own machine off shared members", () => {
		const result = balance(all, {
			demand: {
				...PUBLIC_ORG_PR,
				needsDocker: false,
				isolationRequired: true,
			},
		});
		expect(refusal(result, "arc-remote")).toBe("fleet.isolation");
		expect(refusal(result, "agent-box")).toBe("fleet.isolation");
		expect(refusal(result, "github-hosted-public")).toBeUndefined();
		expect(refusal(result, "hobo-box")).toBeUndefined();
	});

	it("reaches a job queued on another label the member's runners register with", () => {
		const trunk = { ...PUBLIC_ORG_PR, queuedOnLabel: "hobo-trunk" };
		expect(
			balance([member("hobo-box", { concurrency: 3 })], { demand: trunk })
				.refusals[0]?.code,
		).toBe("fleet.label-bound");
		expect(
			balance(
				[
					member("hobo-box", {
						concurrency: 3,
						servesLabels: ["hobo-trunk"],
					}),
				],
				{ demand: trunk },
			).selected?.memberId,
		).toBe("hobo-box");
	});

	it("skips disabled, unhealthy and full members", () => {
		const result = balance([
			member("hobo-box", { concurrency: 3, activeJobs: 3 }),
			member("agent37-vm-4vcpu", { healthy: false }),
			member("modal-sandbox-4vcpu", { enabled: false }),
			member("github-hosted-public", { activeJobs: 20 }),
		]);
		expect(result.selected).toBeUndefined();
		expect(result.refusals.map((entry) => entry.code)).toEqual([
			"fleet.capacity",
			"fleet.unhealthy",
			"fleet.disabled",
			"fleet.capacity",
		]);
	});

	it("keeps a job off a machine class too small for it", () => {
		const privateJob = (machine: FleetDemand["machine"]) =>
			balance(all, {
				demand: {
					...PUBLIC_ORG_PR,
					repository: { visibility: "private", ownerType: "organization" },
					machine,
				},
			});
		// 2 vCPU / 8 GB cannot hold a 16 GB job; a 16 GB class can.
		const memory = privateJob({ memoryGb: 16 });
		expect(refusal(memory, "github-hosted-private")).toBe("fleet.machine");
		expect(refusal(memory, "modal-sandbox-4vcpu")).toBe("fleet.machine");
		expect(refusal(memory, "jog-4vcpu")).toBeUndefined();
		const reason = memory.refusals.find(
			(entry) => entry.memberId === "github-hosted-private",
		)?.reason;
		expect(reason).toBe("job needs 16 GB; this machine class has 8");
		// CPU is checked the same way, on its own.
		const cpu = privateJob({ vcpus: 4 });
		expect(refusal(cpu, "github-hosted-private")).toBe("fleet.machine");
		expect(refusal(cpu, "jog-4vcpu")).toBeUndefined();
		// A job that states no size fits every class.
		expect(refusal(privateJob(undefined), "github-hosted-private")).toBe(
			undefined,
		);
		expect(refusal(privateJob({}), "github-hosted-private")).toBeUndefined();
	});

	it("keeps a job off a provider that would stop its machine first", () => {
		const base = runnerFinancialModel("modal-sandbox-4vcpu");
		if (!base) throw new Error("no model");
		const hourLimit = (minutes: number) =>
			balance(
				[
					{
						...member("modal-sandbox-4vcpu"),
						model: {
							...base,
							capabilities: {
								isolation: "vm",
								architectures: ["x64"],
								maxRuntimeMinutes: 60,
								customImage: true,
								outboundInternet: true,
								egressControl: false,
								selfHostable: false,
								source: "https://example.com/limits",
							},
						},
					},
				],
				{ demand: { ...PUBLIC_ORG_PR, minutes } },
			);
		expect(hourLimit(60).selected?.memberId).toBe("modal-sandbox-4vcpu");
		const over = hourLimit(61);
		expect(over.selected).toBeUndefined();
		expect(over.refusals[0]?.code).toBe("fleet.runtime");
		expect(over.refusals[0]?.reason).toBe(
			"job reserves 61 minutes; one machine runs at most 60",
		);
		// No published limit means none is assumed.
		expect(
			balance([member("modal-sandbox-4vcpu")], {
				demand: { ...PUBLIC_ORG_PR, minutes: 600 },
			}).selected?.memberId,
		).toBe("modal-sandbox-4vcpu");
	});

	it("applies the sandbox providers' documented limits", () => {
		const isolatedJob = (minutes: number, needsDocker = true) =>
			balance(all, {
				demand: {
					...PUBLIC_ORG_PR,
					minutes,
					needsDocker,
					isolationRequired: true,
				},
			});
		// E2B stops a Hobby sandbox after an hour and a Pro one after a day.
		const ninety = isolatedJob(90);
		expect(refusal(ninety, "e2b-hobby-4vcpu")).toBe("fleet.runtime");
		expect(refusal(ninety, "e2b-pro-4vcpu")).toBeUndefined();
		expect(refusal(isolatedJob(60), "e2b-hobby-4vcpu")).toBeUndefined();
		expect(refusal(isolatedJob(1441), "e2b-pro-4vcpu")).toBe("fleet.runtime");
		// Daytona's default class shares the host's kernel; its VM class does not.
		expect(refusal(ninety, "daytona-container-4vcpu")).toBe("fleet.isolation");
		expect(refusal(ninety, "daytona-vm-4vcpu")).toBeUndefined();
		// Lizard documents Docker on its runners, not inside its sandboxes.
		expect(refusal(ninety, "lizard-sandbox-4vcpu")).toBe("fleet.docker");
		expect(refusal(ninety, "lizard-runner-4vcpu")).toBeUndefined();
		expect(
			refusal(isolatedJob(90, false), "lizard-sandbox-4vcpu"),
		).toBeUndefined();
		// None of them has a 16 GB machine in the class the fleet prices.
		const large = balance(all, {
			demand: { ...PUBLIC_ORG_PR, machine: { memoryGb: 16 } },
		});
		for (const id of [
			"daytona-vm-4vcpu",
			"e2b-pro-4vcpu",
			"lizard-runner-4vcpu",
		] as const)
			expect(refusal(large, id), id).toBe("fleet.machine");
	});

	it("does not open a paid plan unless that is allowed", () => {
		const unsubscribed = [
			member("boat-sandbox", { commercial: { subscribed: false } }),
		];
		expect(balance(unsubscribed).refusals[0]?.code).toBe(
			"fleet.agreement.new-denied",
		);
		const opened = balance(unsubscribed, { allowNewProviderAgreements: true });
		expect(opened.selected?.incrementalBilledMicros).toBe(20_006_000);
	});
});

describe("fleet balancing", () => {
	const fleet = (boxActive: number): FleetMemberState[] => [
		member("hobo-box", { concurrency: 3, activeJobs: boxActive }),
		member("boat-sandbox"),
		member("agent37-vm-4vcpu"),
		member("modal-sandbox-4vcpu"),
		member("blacksmith-4vcpu"),
		member("github-hosted-public"),
	];

	it("uses capacity that is already paid for first", () => {
		expect(balance(fleet(0)).selected?.memberId).toBe("hobo-box");
	});

	it("spills to the cheapest rented member when the box is full", () => {
		const result = balance(fleet(3));
		// Blacksmith is inside its included minutes, so it bills nothing.
		expect(result.ranking.map((choice) => choice.memberId)).toEqual([
			"blacksmith-4vcpu",
			"agent37-vm-4vcpu",
			"boat-sandbox",
			"modal-sandbox-4vcpu",
			"github-hosted-public",
		]);
		expect(result.selected?.incrementalBilledMicros).toBe(0);
		expect(result.selected?.usesAllowance).toBe(true);
	});

	it("keeps GitHub-hosted as the last resort even though it is free", () => {
		const result = balance(fleet(3));
		expect(result.ranking.at(-1)?.memberId).toBe("github-hosted-public");
		const alone = balance([
			member("hobo-box", { concurrency: 3, activeJobs: 3 }),
			member("github-hosted-public"),
		]);
		expect(alone.selected?.memberId).toBe("github-hosted-public");
		expect(alone.selected?.role).toBe("last-resort");
	});

	it("lets policy promote a member out of its default tier", () => {
		const result = balance([
			member("hobo-box", { concurrency: 3, activeJobs: 3 }),
			member("agent37-vm-4vcpu"),
			member("github-hosted-public", { role: "overflow" }),
		]);
		expect(result.selected?.memberId).toBe("github-hosted-public");
	});

	it("breaks equal prices by the order the members were authored in", () => {
		const result = balance([
			member("github-hosted-public", { role: "primary" }),
			member("hobo-box", { concurrency: 3 }),
		]);
		expect(result.selected?.memberId).toBe("github-hosted-public");
	});

	it("rounds a fractional microdollar up, never down", () => {
		const result = balance([member("agent37-vm-4vcpu")], {
			demand: { ...PUBLIC_ORG_PR, minutes: 1 },
		});
		expect(result.selected?.incrementalBilledMicros).toBe(522);
	});
});

describe("fleet budget policy", () => {
	const rented = [
		member("modal-sandbox-4vcpu"),
		member("agent37-vm-4vcpu"),
		member("github-hosted-public"),
	];

	it("refuses a member whose job would exceed the per-work ceiling", () => {
		const result = balance(rented, {
			policy: policy({}, [
				{
					key: "work.cost",
					workload: "ci",
					unit: "USD.micros",
					maximum: 10_000,
				},
			]),
		});
		expect(result.selected?.memberId).toBe("agent37-vm-4vcpu");
		expect(
			result.refusals.find((entry) => entry.memberId === "modal-sandbox-4vcpu")
				?.code,
		).toMatch(/^budget\./);
	});

	it("falls through to free capacity when the budget is spent", () => {
		const result = balance(rented, {
			policy: policy({ limitMicros: 5_000_000 }),
			exposureMicros: 5_000_000,
		});
		expect(result.ranking.map((choice) => choice.memberId)).toEqual([
			"github-hosted-public",
		]);
		expect(
			result.refusals.filter(
				(entry) => entry.code === "budget.policy.exhausted",
			),
		).toHaveLength(2);
	});

	it("holds one payer to its own ceiling without stopping the others", () => {
		const result = balance(
			[
				member("agent37-vm-4vcpu", { payerExposureMicros: 999_000 }),
				member("modal-sandbox-4vcpu"),
			],
			{
				policy: policy({}, [
					{
						key: "provider.cost",
						workload: "ci",
						unit: "USD.micros",
						target: "agent37",
						maximum: 1_000_000,
					},
				]),
			},
		);
		expect(result.selected?.memberId).toBe("modal-sandbox-4vcpu");
	});

	it("holds a payer to the operator's own ceiling and the account to its legacy one", () => {
		const capped = balance([
			member("modal-sandbox-4vcpu", {
				payerExposureMicros: 950_000,
				payerBudgetMicros: 1_000_000,
			}),
			member("github-hosted-public"),
		]);
		expect(capped.refusals[0]?.code).toBe("fleet.payer-budget");
		expect(capped.selected?.memberId).toBe("github-hosted-public");
		// A payer already past its ceiling takes no more work, even free work.
		const overrun = balance([
			member("blacksmith-4vcpu", {
				payerExposureMicros: 1_200_000,
				payerBudgetMicros: 1_000_000,
			}),
		]);
		expect(overrun.selected).toBeUndefined();
		expect(overrun.refusals[0]?.code).toBe("fleet.payer-budget");
		const legacy = balance(rented, {
			exposureMicros: 4_999_000,
			ceilingMicros: 5_000_000,
		});
		expect(legacy.ranking.map((choice) => choice.memberId)).toEqual([
			"github-hosted-public",
		]);
		expect(
			legacy.refusals.filter((entry) => entry.code === "fleet.account-budget"),
		).toHaveLength(2);
	});

	it("applies the concurrency and queue-age ceilings CI admission applies", () => {
		const constrained = policy({}, [
			{ key: "work.concurrent", workload: "ci", unit: "count", maximum: 4 },
			{
				key: "ci.queue.duration",
				workload: "ci",
				unit: "ms",
				maximum: 900_000,
			},
		]);
		expect(
			balance(rented, {
				policy: constrained,
				activeWork: 4,
				demand: { ...PUBLIC_ORG_PR, queueDurationMs: 1 },
			}).selected,
		).toBeUndefined();
		expect(
			balance(rented, {
				policy: constrained,
				activeWork: 0,
				demand: { ...PUBLIC_ORG_PR, queueDurationMs: 60_000 },
			}).selected?.memberId,
		).toBe("agent37-vm-4vcpu");
	});

	it("spends included minutes before money under maximize-credits", () => {
		const members = [
			member("agent37-vm-4vcpu"),
			member("blacksmith-4vcpu", {
				commercial: { subscribed: true, allowanceRemainingMinutes: "9" },
			}),
		];
		// Nine free minutes leave one paid minute: 8,000 micros against 5,220.
		expect(balance(members).selected?.memberId).toBe("agent37-vm-4vcpu");
		expect(
			balance(members, { policy: policy({ objective: "maximize-credits" }) })
				.selected?.memberId,
		).toBe("blacksmith-4vcpu");
	});

	it("refuses everything under a policy that does not cover CI", () => {
		const result = balance(rented, {
			policy: policy({ workloads: ["hosting"] }),
		});
		expect(result.selected).toBeUndefined();
		expect(
			result.refusals.every((entry) => entry.code.startsWith("budget.")),
		).toBe(true);
	});
});

describe("fleet route table", () => {
	const classes = [
		{
			name: "pr",
			hoboLabel: "hobo",
			demand: {
				minutes: 10,
				repository: { visibility: "public", ownerType: "organization" },
				forkPullRequest: false,
				needsDocker: true,
				isolationRequired: true,
			},
		},
		{
			name: "trunk",
			hoboLabel: "hobo-trunk",
			demand: {
				minutes: 20,
				repository: { visibility: "public", ownerType: "organization" },
				forkPullRequest: false,
				needsDocker: true,
				isolationRequired: true,
			},
		},
	] as const;
	const table = (members: readonly FleetMemberState[]) =>
		fleetRouteTable({
			members,
			classes,
			policy: policy(),
			exposureMicros: 0,
			activeWork: 0,
			now: NOW,
			allowNewProviderAgreements: false,
		});

	it("keeps every class on its hobo label while the box has room", () => {
		expect(
			table([
				member("hobo-box", { concurrency: 3 }),
				member("github-hosted-public"),
			]).routes,
		).toEqual({ pr: "hobo", trunk: "hobo-trunk" });
	});

	it("points new jobs at a label provider once the box is full", () => {
		const routed = table([
			member("hobo-box", { concurrency: 3, activeJobs: 3 }),
			member("blacksmith-4vcpu"),
			member("github-hosted-public"),
		]);
		expect(routed.routes).toEqual({
			pr: "blacksmith-4vcpu-ubuntu-2404",
			trunk: "blacksmith-4vcpu-ubuntu-2404",
		});
		expect(fleetRoutesVariableValue(routed)).toBe(
			'{"pr":"blacksmith-4vcpu-ubuntu-2404","trunk":"blacksmith-4vcpu-ubuntu-2404"}',
		);
	});

	it("stays on the hobo label when the best member is injected or none is admitted", () => {
		expect(
			table([
				member("hobo-box", { concurrency: 3, activeJobs: 3 }),
				member("agent37-vm-4vcpu"),
				member("github-hosted-public"),
			]).routes.pr,
		).toBe("hobo");
		expect(
			table([member("hobo-box", { concurrency: 3, activeJobs: 3 })]).routes,
		).toEqual({ pr: "hobo", trunk: "hobo-trunk" });
	});

	it("rejects a repeated or malformed class", () => {
		expect(() =>
			fleetRouteTable({
				members: [],
				classes: [classes[0], classes[0]],
				policy: policy(),
				exposureMicros: 0,
				activeWork: 0,
				now: NOW,
				allowNewProviderAgreements: false,
			}),
		).toThrow(/route class/);
	});
});
