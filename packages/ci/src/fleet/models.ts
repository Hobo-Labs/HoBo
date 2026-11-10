/**
 * Financial models for the runner providers the HoBo CI fleet can draw on.
 *
 * One model is one machine class at one provider: what a minute costs, how the
 * provider rounds it, what it gives away each month, what it charges to have
 * an account at all, how much of it can run at once, and which repositories
 * it will serve. Nothing here decides anything. `./pricing.ts` compiles a
 * model into an `@hobo/pricing` catalog the quote engine rates, and
 * `./balance.ts` puts those quotes through the shared budget policy.
 *
 * Every number carries the page it was read from and the day it was read.
 * `derived: true` marks a figure the vendor does not print for this machine
 * class and that was computed from one it does print; the arithmetic is in the
 * note. A model past `validUntil` is refused by the quote engine, so a stale
 * price takes its provider out of rotation instead of being trusted.
 */

/** How a job reaches the capacity. */
export type FleetBinding =
	/** The relay starts a one-shot runner labelled for the job on this compute. */
	| "inject"
	/** The provider brings the runner; the job must ask for the provider's label. */
	| "label";

/** Where a member sits before price is compared. */
export type FleetRole =
	/** Capacity already paid for. Used first. */
	| "primary"
	/** Rented capacity. Ranked by incremental billed cost. */
	| "overflow"
	/** Considered only when no primary or overflow member is admitted. */
	| "last-resort";

export type RunnerBilling =
	/** Each job is rounded up to a whole minute. */
	| "per-minute-ceil"
	/** Metered by the second; no rounding to the minute. */
	| "per-second";

export type PublicRepositorySupport =
	| "yes"
	/** Off until the owner turns it on at the provider. */
	| "opt-in"
	| "no";

export type RunnerFinancialModel = Readonly<{
	/** Fleet member id and pricing product id. */
	id: string;
	/** `DesiredCiPolicy` provider kind this model prices. */
	provider: string;
	displayName: string;
	binding: FleetBinding;
	role: FleetRole;
	/** Label the job asks for (label) or the runner registers with (inject). */
	runsOn: string;
	machine: Readonly<{ vcpus: number; memoryGb: number }>;
	/** Exact USD per runner minute for this machine class. */
	usdPerMinute: string;
	billing: RunnerBilling;
	/** Plan fee owed each month for having an account. Absent means none. */
	monthlyFeeUsd?: string;
	/** Minutes of this machine class included each month. Absent means none. */
	monthlyFreeMinutes?: string;
	/**
	 * The provider's own ceiling on jobs running at once. Absent means the
	 * provider publishes none, and only the budget bounds it.
	 */
	concurrency?: number;
	eligibility: Readonly<{
		publicRepositories: PublicRepositorySupport;
		privateRepositories: boolean;
		/** Serves repositories owned by an organization only. */
		organizationOnly: boolean;
		/** A job can use a Docker daemon. */
		docker: boolean;
		/** Jobs from forks may run here. */
		forkPullRequests: boolean;
		/**
		 * Every job gets a machine nothing else shares and that is discarded
		 * afterwards. Admission requires this for public repositories and pull
		 * requests; a shared cluster or a workstation does not qualify.
		 */
		isolated: boolean;
	}>;
	evidence: Readonly<{
		source: string;
		observedAt: string;
		validUntil: string;
		/** The vendor prints no figure for this class; see `note`. */
		derived: boolean;
		note: string;
	}>;
}>;

const OBSERVED_AT = "2026-11-09T00:00:00Z";
/** Prices are re-read at least quarterly. */
const VALID_UNTIL = "2027-02-09T00:00:00Z";

function evidence(
	source: string,
	note: string,
	derived = false,
): RunnerFinancialModel["evidence"] {
	return {
		source,
		observedAt: OBSERVED_AT,
		validUntil: VALID_UNTIL,
		derived,
		note,
	};
}

const HOSTED_VM = {
	privateRepositories: true,
	docker: true,
	isolated: true,
} as const;

/**
 * The fleet, in the order the page reads: capacity that is already paid for,
 * then rented capacity, then GitHub's own runners.
 */
export const RUNNER_FINANCIAL_MODELS = [
	{
		id: "hobo-box",
		provider: "hobo-box-worker",
		displayName: "HoBo box worker",
		binding: "inject",
		role: "primary",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 16 },
		usdPerMinute: "0",
		billing: "per-second",
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		evidence: evidence(
			"https://github.com/Hobo-Labs/HoBo/blob/main/packages/ci/RUNNER-QUEUE.md",
			"Operator-owned host; a job adds no marginal charge. Slots come from HOBO_CI_WORKER_SLOTS, not from this model.",
		),
	},
	{
		id: "agent-box",
		// The existing trusted workstation runner: `hobo ci` in pull mode on the
		// machine of the agent that opened the pull request.
		provider: "local",
		displayName: "Box of the agent that opened the pull request",
		binding: "label",
		role: "primary",
		runsOn: "hobo-local-host",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0",
		billing: "per-second",
		eligibility: {
			publicRepositories: "yes",
			privateRepositories: true,
			organizationOnly: false,
			// An agent session's container has no Docker daemon to offer.
			docker: false,
			// The box holds the agent's own credentials.
			forkPullRequests: false,
			isolated: false,
		},
		evidence: evidence(
			"https://github.com/Hobo-Labs/HoBo/blob/main/packages/ci-gh-actions/README.md",
			"The agent's session already pays for the machine; a job adds no marginal charge. One job at a time.",
		),
		concurrency: 1,
	},
	{
		id: "arc-remote",
		provider: "kubernetes",
		displayName: "Remote actions-runner-controller scale set",
		binding: "label",
		// Owned, but kept behind the box: it is the first place work spills to.
		role: "overflow",
		runsOn: "hobo-arc",
		machine: { vcpus: 4, memoryGb: 16 },
		usdPerMinute: "0",
		billing: "per-second",
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: false,
			// Pods share the operator's cluster and its node credentials.
			isolated: false,
		},
		evidence: evidence(
			"https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/deploy-runner-scale-sets",
			"Operator-owned cluster; a job adds no marginal charge. Concurrency is the scale set's maxRunners, authored in policy.",
		),
	},
	{
		id: "boat",
		provider: "boat",
		displayName: "Boat CI runner",
		binding: "label",
		role: "overflow",
		runsOn: "boat",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.0006",
		billing: "per-second",
		monthlyFeeUsd: "20.00",
		concurrency: 100,
		eligibility: {
			publicRepositories: "opt-in",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: false,
		},
		evidence: evidence(
			"https://docs.boat.dev/pricing.md",
			"Printed as $0.036 per hour for the default 4 vCPU / 8 GB size; 0.036 / 60 = 0.0006. $20/mo plan allows 100 sandboxes at once.",
			true,
		),
	},
	{
		id: "boat-sandbox",
		provider: "boat",
		displayName: "Boat sandbox (API)",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.0006",
		billing: "per-second",
		monthlyFeeUsd: "20.00",
		concurrency: 100,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		evidence: evidence(
			"https://docs.boat.dev/pricing.md",
			"Same machine and rate as the CI runner, started through POST /api/v1/sandboxes. 12 starts a minute, 200 a day on the $20 plan.",
			true,
		),
	},
	{
		id: "agent37-vm-4vcpu",
		provider: "agent37",
		displayName: "Agent37 VM instance",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.000522",
		billing: "per-second",
		concurrency: 3,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		evidence: evidence(
			"https://www.agent37.com/docs/agents-api/vm-instances.md",
			"Printed as $22.54 a month for 4 vCPU / 8 GB, billed by the minute; 22.54 / 43200 rounded up to the microdollar. Three instances at once until the wallet is topped up. Running the Actions runner there is untested.",
			true,
		),
	},
	{
		id: "jog-4vcpu",
		provider: "jog",
		displayName: "Jog runner",
		binding: "label",
		role: "overflow",
		runsOn: "jog-4vcpu",
		machine: { vcpus: 4, memoryGb: 16 },
		usdPerMinute: "0.0024",
		billing: "per-second",
		monthlyFreeMinutes: "2500",
		eligibility: {
			publicRepositories: "no",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: false,
		},
		evidence: evidence(
			"https://usejog.com/docs/runners/",
			"$0.0024 a minute is printed. The 5,000 free minutes are counted at 2 vCPU and a 4 vCPU minute counts twice, so 2,500 here.",
			true,
		),
	},
	{
		id: "modal-sandbox-4vcpu",
		provider: "modal",
		displayName: "Modal Sandbox",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.007932",
		billing: "per-second",
		concurrency: 100,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		evidence: evidence(
			"https://modal.com/pricing",
			"Printed per second: $0.00003942 a physical core (2 vCPU) and $0.00000667 a GiB. (2 x 0.00003942 + 8 x 0.00000667) x 60 = 0.007932. Starter plan runs 100 containers; Docker needs the VM runtime.",
			true,
		),
	},
	{
		id: "blacksmith-4vcpu",
		provider: "blacksmith",
		displayName: "Blacksmith runner",
		binding: "label",
		role: "overflow",
		runsOn: "blacksmith-4vcpu-ubuntu-2404",
		machine: { vcpus: 4, memoryGb: 16 },
		usdPerMinute: "0.008",
		billing: "per-second",
		monthlyFreeMinutes: "1500",
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: true,
			forkPullRequests: false,
		},
		evidence: evidence(
			"https://www.blacksmith.sh/pricing",
			"$0.004 a minute is printed for 2 vCPU and the rate scales with vCPU, so 0.008 here. The 3,000 free minutes are counted at 2 vCPU, so 1,500 here.",
			true,
		),
	},
	{
		id: "depot-4vcpu",
		provider: "depot",
		displayName: "Depot runner",
		binding: "label",
		role: "overflow",
		runsOn: "depot-ubuntu-24.04-4",
		machine: { vcpus: 4, memoryGb: 16 },
		usdPerMinute: "0.012",
		billing: "per-second",
		monthlyFeeUsd: "20.00",
		monthlyFreeMinutes: "1000",
		eligibility: {
			publicRepositories: "opt-in",
			...HOSTED_VM,
			organizationOnly: true,
			forkPullRequests: false,
		},
		evidence: evidence(
			"https://depot.dev/docs/github-actions/runner-types",
			"$0.012 a minute is printed for depot-ubuntu-24.04-4. The $20 plan includes 2,000 minutes counted at 2 vCPU with a 2x multiplier for this size, so 1,000 here.",
		),
	},
	{
		id: "github-hosted-public",
		provider: "github",
		displayName: "GitHub-hosted runner (public repository)",
		binding: "label",
		role: "last-resort",
		runsOn: "ubuntu-24.04",
		machine: { vcpus: 4, memoryGb: 16 },
		usdPerMinute: "0",
		billing: "per-minute-ceil",
		concurrency: 20,
		eligibility: {
			publicRepositories: "yes",
			privateRepositories: false,
			organizationOnly: false,
			docker: true,
			forkPullRequests: true,
			isolated: true,
		},
		evidence: evidence(
			"https://docs.github.com/en/actions/reference/runners/github-hosted-runners",
			'"Use of the standard GitHub-hosted runners is free and unlimited on public repositories." 20 jobs at once on the Free plan, 40 on Pro, 60 on Team.',
		),
	},
	{
		id: "github-hosted-private",
		provider: "github",
		displayName: "GitHub-hosted runner (private repository)",
		binding: "label",
		role: "last-resort",
		runsOn: "ubuntu-24.04",
		machine: { vcpus: 2, memoryGb: 8 },
		usdPerMinute: "0.006",
		billing: "per-minute-ceil",
		concurrency: 20,
		eligibility: {
			publicRepositories: "no",
			privateRepositories: true,
			organizationOnly: false,
			docker: true,
			forkPullRequests: true,
			isolated: true,
		},
		evidence: evidence(
			"https://docs.github.com/en/billing/reference/actions-runner-pricing",
			"$0.006 a minute for the 2-core Linux runner, each job rounded up to the minute. Included plan minutes are an account fact and are supplied as allowance state, not here.",
		),
	},
] as const satisfies readonly RunnerFinancialModel[];

export type RunnerModelId = (typeof RUNNER_FINANCIAL_MODELS)[number]["id"];

export function runnerFinancialModel(
	id: string,
): RunnerFinancialModel | undefined {
	return RUNNER_FINANCIAL_MODELS.find((model) => model.id === id);
}

/** Provider kinds the fleet has a financial model for. */
export const FLEET_PROVIDER_KINDS: readonly string[] = [
	...new Set(RUNNER_FINANCIAL_MODELS.map((model) => model.provider)),
].sort();
