/**
 * Financial models for the runner providers HoBo CI runner routing can draw on.
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
export type RunnerBinding =
	/** The relay starts a one-shot runner labelled for the job on this compute. */
	| "inject"
	/** The provider brings the runner; the job must ask for the provider's label. */
	| "label";

/** Where a member sits before price is compared. */
export type RunnerProviderRole =
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

/** What keeps one job's machine apart from the provider's other tenants. */
export type RunnerIsolation =
	/** A virtual machine with its own kernel; microVMs are virtual machines. */
	| "vm"
	/** A container whose system calls go to a user-space kernel, not the host's. */
	| "sandboxed-container"
	/** A container on a kernel it shares with other containers. */
	| "container";

export type RunnerArchitecture = "x64" | "arm64";

/**
 * What a provider's machine can and cannot do, as its vendor documents it.
 * `./balance.ts` refuses a job that asks for more than this; the rest is
 * printed on the providers page. An absent optional field means the vendor
 * publishes no figure, never that there is no limit.
 */
export type RunnerCapabilities = Readonly<{
	isolation: RunnerIsolation;
	architectures?: readonly RunnerArchitecture[];
	/** Longest one machine may run, in whole minutes. */
	maxRuntimeMinutes?: number;
	/** Largest machine one job can be given. */
	maxMachine?: Readonly<{ vcpus: number; memoryGb: number }>;
	/**
	 * The four flags below are true only where the vendor documents the
	 * ability. False covers both "documented as absent" and "not stated".
	 */
	/** The machine starts from an image the operator supplies. */
	customImage: boolean;
	/** The machine reaches the internet without extra setup. */
	outboundInternet: boolean;
	/** Outbound traffic can be limited to an allow list at the provider. */
	egressControl: boolean;
	/** The provider's software can run on the operator's own machines. */
	selfHostable: boolean;
	/** Vendor page the limits were read from. */
	source: string;
}>;

export type RunnerFinancialModel = Readonly<{
	/** Runner provider id and pricing product id. */
	id: string;
	/** `DesiredCiPolicy` provider kind this model prices. */
	provider: string;
	displayName: string;
	binding: RunnerBinding;
	role: RunnerProviderRole;
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
	/**
	 * Documented limits of the machine. Absent for a model whose limits have
	 * not been read from the vendor; nothing is assumed in that case.
	 */
	capabilities?: RunnerCapabilities;
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

/** The day the sandbox providers were read. */
const SANDBOXES_OBSERVED_AT = "2026-11-10T00:00:00Z";

function evidence(
	source: string,
	note: string,
	derived = false,
	observedAt = OBSERVED_AT,
): RunnerFinancialModel["evidence"] {
	return {
		source,
		observedAt,
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
 * The providers, in the order the page reads: capacity that is already paid for,
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
		id: "daytona-vm-4vcpu",
		provider: "daytona",
		displayName: "Daytona sandbox (Linux VM)",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00552",
		billing: "per-second",
		concurrency: 62,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			architectures: ["x64"],
			maxMachine: { vcpus: 4, memoryGb: 8 },
			customImage: false,
			outboundInternet: true,
			egressControl: true,
			selfHostable: true,
			source: "https://www.daytona.io/docs/en/sandboxes.md",
		},
		evidence: evidence(
			"https://www.daytona.io/pricing",
			"Printed per hour: $0.0504 a vCPU and $0.0162 a GiB, billed per second. (4 x 0.0504 + 8 x 0.0162) / 60 = 0.00552. 4 vCPU / 8 GB is the largest Linux sandbox. Modelled at Tier 3 ($500 top-up): 250 vCPU at once, and the first tier whose outbound network is open. The VM class takes no Dockerfile. No maximum runtime is published; auto-stop has to be turned off. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "daytona-container-4vcpu",
		provider: "daytona",
		displayName: "Daytona sandbox (container)",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00552",
		billing: "per-second",
		concurrency: 62,
		eligibility: {
			publicRepositories: "yes",
			privateRepositories: true,
			organizationOnly: false,
			docker: true,
			forkPullRequests: true,
			// "runs as a Linux container and shares the kernel of the host."
			isolated: false,
		},
		capabilities: {
			isolation: "container",
			architectures: ["x64"],
			maxMachine: { vcpus: 4, memoryGb: 8 },
			customImage: true,
			outboundInternet: true,
			egressControl: true,
			selfHostable: true,
			source: "https://www.daytona.io/docs/en/linux-sandboxes.md",
		},
		evidence: evidence(
			"https://www.daytona.io/pricing",
			"Same rates and tier as the Linux VM class. The default class: a container that shares the host's kernel, started from an image or Dockerfile, with Docker-in-Docker documented. It is not a machine of its own, so it is never chosen for a public repository or a pull request.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "e2b-hobby-4vcpu",
		provider: "e2b",
		displayName: "E2B sandbox (Hobby)",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00552",
		billing: "per-second",
		concurrency: 10,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			architectures: ["x64"],
			maxRuntimeMinutes: 60,
			maxMachine: { vcpus: 8, memoryGb: 8 },
			customImage: true,
			outboundInternet: true,
			egressControl: true,
			selfHostable: true,
			source: "https://docs.e2b.dev/billing.md",
		},
		evidence: evidence(
			"https://e2b.dev/pricing",
			"Printed per second: $0.000014 a vCPU and $0.0000045 a GiB. (4 x 0.000014 + 8 x 0.0000045) x 60 = 0.00552. Hobby: no fee, 10 sandboxes at once, one hour a sandbox. The $100 credit is one-time, so it is not an included allowance here. The pricing page lists custom CPU and RAM under Pro only while the billing page gives Hobby an 8 vCPU ceiling, so this size on Hobby is unconfirmed. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "e2b-pro-4vcpu",
		provider: "e2b",
		displayName: "E2B sandbox (Pro)",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00552",
		billing: "per-second",
		monthlyFeeUsd: "150.00",
		concurrency: 100,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			architectures: ["x64"],
			maxRuntimeMinutes: 1440,
			maxMachine: { vcpus: 8, memoryGb: 8 },
			customImage: true,
			outboundInternet: true,
			egressControl: true,
			selfHostable: true,
			source: "https://docs.e2b.dev/billing.md",
		},
		evidence: evidence(
			"https://e2b.dev/pricing",
			"Same rates as Hobby. Pro: $150 a month, 100 sandboxes at once, 24 hours a sandbox. More than 8 GiB is by request to the vendor. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "lizard-sandbox-4vcpu",
		provider: "lizard",
		displayName: "Lizard sandbox (API)",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00054",
		billing: "per-second",
		monthlyFeeUsd: "19.00",
		monthlyFreeMinutes: "35185",
		concurrency: 10,
		eligibility: {
			publicRepositories: "yes",
			privateRepositories: true,
			organizationOnly: false,
			// Docker inside a sandbox is not documented.
			docker: false,
			forkPullRequests: true,
			isolated: true,
		},
		capabilities: {
			isolation: "vm",
			maxRuntimeMinutes: 35760,
			maxMachine: { vcpus: 8, memoryGb: 16 },
			customImage: false,
			outboundInternet: true,
			egressControl: false,
			selfHostable: false,
			source: "https://lizard.build/docs/platform/limits.md",
		},
		evidence: evidence(
			"https://lizard.build/docs/platform/limits.md",
			"Printed as $0.0324 an hour for the medium size (4 vCPU / 8 GB); 0.0324 / 60 = 0.00054. Pro ($19 a month, with $19 of usage included) runs 40 vCPU of sandboxes at once, so 10 of this size. A sandbox stops after 596 hours, and a command run through exec after 600 seconds, so a runner has to be started detached. Docker inside a sandbox and its CPU architecture are not published. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "northflank-sandbox-4vcpu",
		provider: "northflank",
		displayName: "Northflank sandbox",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.002222",
		billing: "per-second",
		eligibility: {
			publicRepositories: "yes",
			privateRepositories: true,
			organizationOnly: false,
			// Docker inside a sandbox is not documented.
			docker: false,
			forkPullRequests: true,
			isolated: true,
		},
		capabilities: {
			isolation: "vm",
			maxMachine: { vcpus: 8, memoryGb: 16 },
			customImage: true,
			outboundInternet: false,
			egressControl: false,
			selfHostable: false,
			source:
				"https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas.md",
		},
		evidence: evidence(
			"https://northflank.com/pricing",
			"Printed per hour, billed by the second: $0.01667 a vCPU and $0.00833 a GB. The nf-compute-400 plan is 4 vCPU / 8192 MiB: (4 x 0.01667 + 8 x 0.00833) / 60 = 0.002222. The default quota allows 8 vCPU and 16 GiB an instance. Sandboxes are microVMs for CPU workloads. Docker inside one, outbound network and a limit on sandboxes at once are not stated. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "freestyle-vm-4vcpu",
		provider: "freestyle",
		displayName: "Freestyle VM",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.004408",
		billing: "per-second",
		concurrency: 10,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			maxMachine: { vcpus: 4, memoryGb: 8 },
			customImage: false,
			// "A VM gets nothing implicitly — no outbound Internet, no inbound"
			outboundInternet: false,
			egressControl: true,
			selfHostable: false,
			source: "https://www.freestyle.sh/docs/vms/network/firewall.md",
		},
		evidence: evidence(
			"https://www.freestyle.sh/pricing",
			"Printed per hour, metered per second: $0.04032 a vCPU and $0.0129 a GiB. (4 x 0.04032 + 8 x 0.0129) / 60 = 0.004408. The free plan runs 10 VMs at once of at most 4 vCPU / 8 GiB; Hobby ($50 a month) 40 of 8 / 16; Pro ($500) 400 of 32 / 64. MicroVMs with a full kernel, so Docker runs natively. A VM has no outbound network until its firewall allows it, which a runner needs. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "blaxel-sandbox-4vcpu",
		provider: "blaxel",
		displayName: "Blaxel sandbox",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00552",
		billing: "per-second",
		concurrency: 10,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			customImage: true,
			outboundInternet: false,
			egressControl: false,
			selfHostable: false,
			source: "https://docs.blaxel.ai/Sandboxes/Overview.md",
		},
		evidence: evidence(
			"https://blaxel.ai/pricing",
			'Billed on memory alone: "$0.0000115 / GB RAM · second", and "a sandbox with 8 GB memory is allocated 4 CPU cores". 8 x 0.0000115 x 60 = 0.00552. The free tier\'s sandbox limit is 10 (50 at $20 a month, 200 at $50), and standby sandboxes count toward it. MicroVMs; a docker-in-sandbox image is documented. Outbound network and a largest self-serve machine are not stated. Running the Actions runner there is untested.',
			true,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "runloop-devbox-4vcpu",
		provider: "runloop",
		displayName: "Runloop Devbox",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.01056",
		billing: "per-second",
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			maxMachine: { vcpus: 16, memoryGb: 64 },
			customImage: true,
			outboundInternet: true,
			egressControl: true,
			selfHostable: false,
			source: "https://docs.runloop.ai/docs/devboxes/configuration/sizes.md",
		},
		evidence: evidence(
			"https://runloop.ai/pricing",
			'Printed per second: "$0.00003 / CPU-sec" and "$0.000007 / GB-sec". (4 x 0.00003 + 8 x 0.000007) x 60 = 0.01056. Basic is free plus usage and Pro is $250 a month plus usage; which plan a custom 4 CPU size needs is not printed, so no fee is modelled. A trial account runs 3 devboxes at once; no limit is printed after it. A micro-VM around a container, with Docker-in-Docker blueprints and unrestricted network by default. Running the Actions runner there is untested.',
			true,
			SANDBOXES_OBSERVED_AT,
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
		id: "lizard-runner-4vcpu",
		provider: "lizard",
		displayName: "Lizard runner",
		binding: "label",
		role: "overflow",
		runsOn: "lizard-medium-ubuntu-2404",
		machine: { vcpus: 4, memoryGb: 8 },
		usdPerMinute: "0.00054",
		billing: "per-second",
		monthlyFeeUsd: "19.00",
		monthlyFreeMinutes: "35185",
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: true,
			// Fork jobs are mentioned, but no fork policy is published.
			forkPullRequests: false,
		},
		capabilities: {
			isolation: "vm",
			architectures: ["x64"],
			maxMachine: { vcpus: 8, memoryGb: 16 },
			customImage: false,
			outboundInternet: true,
			egressControl: false,
			selfHostable: false,
			source: "https://lizard.build/ci",
		},
		evidence: evidence(
			"https://lizard.build/ci",
			'$0.00054 a minute is printed for the medium runner, billed by the second. The $19 Pro plan "includes usage equal to its price each month": 19 / 0.00054 = 35,185 minutes. Organizations only. Public repositories are read from "keeps a cache disk only for private repositories", which is not an outright statement. "Jobs from forks start on an empty disk" is all that is said about forks, so they are not routed there. The vendor\'s action READMEs write the label as lizard-4vcpu-ubuntu-2404 instead. No limit on jobs at once is published.',
			false,
			SANDBOXES_OBSERVED_AT,
		),
	},
	{
		id: "cloudflare-sandbox-4vcpu",
		provider: "cloudflare-sandbox",
		displayName: "Cloudflare Sandbox",
		binding: "inject",
		role: "overflow",
		runsOn: "hobo",
		machine: { vcpus: 4, memoryGb: 12 },
		usdPerMinute: "0.0066",
		billing: "per-second",
		monthlyFeeUsd: "5.00",
		monthlyFreeMinutes: "93",
		concurrency: 375,
		eligibility: {
			publicRepositories: "yes",
			...HOSTED_VM,
			organizationOnly: false,
			forkPullRequests: true,
		},
		capabilities: {
			isolation: "vm",
			maxMachine: { vcpus: 4, memoryGb: 12 },
			customImage: true,
			// The SDK 0.x guide and the current security page disagree.
			outboundInternet: false,
			egressControl: true,
			selfHostable: false,
			source:
				"https://developers.cloudflare.com/containers/platform/limits/index.md",
		},
		evidence: evidence(
			"https://developers.cloudflare.com/containers/pricing/",
			"The standard-4 instance, 4 vCPU / 12 GiB and the largest there is. Printed per second: $0.000020 a vCPU and $0.0000025 a GiB; CPU is charged for active use only, so (4 x 0.00002 + 12 x 0.0000025) x 60 = 0.0066 is the ceiling. The $5 Workers Paid plan includes 375 vCPU-minutes, 93 minutes of this class. 1,500 vCPU at once an account, so 375. Each instance is a Firecracker microVM that is never stopped for running too long, and a Docker-in-Docker guide exists. One page says internet access is on by default and another that it is off. This is not the `cloudflare` policy kind, which is the Cloudflare CI pipeline backend. Running the Actions runner there is untested.",
			true,
			SANDBOXES_OBSERVED_AT,
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

/** Provider kinds runner routing has a financial model for. */
export const RUNNER_PROVIDER_KINDS: readonly string[] = [
	...new Set(RUNNER_FINANCIAL_MODELS.map((model) => model.provider)),
].sort();
