/**
 * Default provider registry document for the example. Providers are the
 * hosted/self-hosted Actions runner providers curated by
 * github.com/neysofu/awesome-github-actions-runners plus GitHub-hosted and
 * genuine self-hosted pools. All third-party prices and free tiers are
 * DECLARED_UNVERIFIED snapshots of public pricing pages — ranking input,
 * never billing input — and operators are expected to override them (see
 * README). The document is data, not code: it crosses the same
 * parse-don't-validate boundary (`parseRegistryDocument`) as any untrusted
 * registry an operator supplies, and the router core never branches on the
 * provider names below.
 *
 * Every third-party rung is guarded behind an HOBO_RB_ENABLE_* variable so
 * the dispatcher can only route to providers whose GitHub App/runner pool
 * is actually installed for the repository.
 */

const DECLARED = "COST_TRUST_DECLARED_UNVERIFIED";
const REPORTED = "COST_TRUST_PROVIDER_REPORTED";

function enableGuard(name: string) {
	return [{ variable: `HOBO_RB_ENABLE_${name}`, exists: true }];
}

export const DEFAULT_REGISTRY_DOCUMENT = {
	providers: [
		{
			id: "github_hosted",
			displayName: "GitHub-hosted runners",
			kind: "PROVIDER_KIND_GITHUB_HOSTED",
			runsOnLabels: ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"],
			cost: {
				// Free plan: 2,000 included minutes/month on private repos;
				// public repos on standard runners bill nothing at all.
				freeUnitsPerMonth: 2000,
				freeTierResetDay: 1,
				listPriceUsdPerUnit: 0.006,
				unit: "minute",
				includedMultiplier: 1,
				trust: REPORTED,
			},
			docsUrl: "https://docs.github.com/billing/concepts/product-billing/github-actions",
		},
		{
			id: "self_hosted",
			displayName: "Self-hosted runner pool",
			kind: "PROVIDER_KIND_SELF_HOSTED",
			runsOnLabels: ["self-hosted"],
			cost: {
				// BYO infrastructure: marginal per-minute cost declared 0; the
				// idle cost lives outside this ledger.
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://docs.github.com/actions/hosting-your-own-runners",
		},
		{
			id: "requesting_machine",
			displayName: "Requesting machine (ephemeral last resort)",
			kind: "PROVIDER_KIND_SELF_HOSTED",
			runsOnLabels: ["hobo-last-resort"],
			cost: {
				// The developer/agent machine that requested CI, registered as
				// an ephemeral self-hosted runner via `pnpm run host-runner`.
				// Declared 0 marginal cost, but its rung is flagged
				// last_resort so the dispatcher never prefers it while any
				// normal provider is usable.
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://docs.github.com/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners",
		},
		{
			id: "namespace",
			displayName: "Namespace",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["nscloud-ubuntu-24.04-amd64-2x4"],
			cost: {
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.004,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://namespace.so",
		},
		{
			id: "buildjet",
			displayName: "BuildJet",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["buildjet-2vcpu-ubuntu-2204"],
			cost: {
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.004,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://buildjet.com",
		},
		{
			id: "actuated",
			displayName: "Actuated",
			kind: "PROVIDER_KIND_BYOC_THIRD_PARTY",
			runsOnLabels: ["actuated-4cpu-8gb"],
			cost: {
				// Flat-rate subscription over your own hosts; nominal amortized
				// per-minute declaration.
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.002,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://actuated.dev",
		},
		{
			id: "warpbuild",
			displayName: "WarpBuild",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["warp-ubuntu-latest-x64-2x"],
			cost: {
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.003,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://warpbuild.com",
		},
		{
			id: "blacksmith",
			displayName: "Blacksmith",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["blacksmith-2vcpu-ubuntu-2404"],
			cost: {
				// 3,000 free minutes/month on the free plan, then ~half
				// GitHub's list price.
				freeUnitsPerMonth: 3000,
				freeTierResetDay: 1,
				listPriceUsdPerUnit: 0.004,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://blacksmith.sh",
		},
		{
			id: "ubicloud",
			displayName: "Ubicloud",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["ubicloud-standard-2"],
			cost: {
				// 1,250 free minutes/month, then ~10x cheaper than GitHub-hosted.
				freeUnitsPerMonth: 1250,
				freeTierResetDay: 1,
				listPriceUsdPerUnit: 0.0008,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://ubicloud.com",
		},
		{
			id: "runs_on",
			displayName: "RunsOn (your AWS account)",
			kind: "PROVIDER_KIND_BYOC_THIRD_PARTY",
			runsOnLabels: ["runs-on,runner=2cpu-linux-x64"],
			cost: {
				// License + AWS passthrough; declared nominal marginal rate.
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.001,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://runs-on.com",
		},
		{
			id: "cirun",
			displayName: "Cirun (your cloud account)",
			kind: "PROVIDER_KIND_BYOC_THIRD_PARTY",
			runsOnLabels: ["cirun-runner"],
			cost: {
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.001,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://cirun.io",
		},
		{
			id: "depot",
			displayName: "Depot runners",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["depot-ubuntu-24.04"],
			cost: {
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.004,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://depot.dev",
		},
		{
			id: "cirrus",
			displayName: "Cirrus Runners",
			kind: "PROVIDER_KIND_MANAGED_THIRD_PARTY",
			runsOnLabels: ["ghcr.io/cirruslabs/ubuntu-runner-amd64:24.04"],
			cost: {
				// Fixed monthly price per runner slot, unlimited minutes;
				// nominal amortized per-minute declaration.
				freeUnitsPerMonth: 0,
				freeTierResetDay: 0,
				listPriceUsdPerUnit: 0.002,
				unit: "minute",
				includedMultiplier: 1,
				trust: DECLARED,
			},
			docsUrl: "https://cirrus-runners.app",
		},
	],
	tracks: [
		{
			resource: "runner.linux.small",
			variable: "HOBO_RUNNER_LINUX_SMALL",
			rungs: [
				{ value: "ubuntu-latest", providerId: "github_hosted", requires: [] },
				{
					value: "self-hosted",
					providerId: "self_hosted",
					requires: enableGuard("SELF_HOSTED"),
				},
				{
					value: "ubicloud-standard-2",
					providerId: "ubicloud",
					requires: enableGuard("UBICLOUD"),
				},
				{
					value: "blacksmith-2vcpu-ubuntu-2404",
					providerId: "blacksmith",
					requires: enableGuard("BLACKSMITH"),
				},
				{
					value: "runs-on,runner=2cpu-linux-x64",
					providerId: "runs_on",
					requires: enableGuard("RUNS_ON"),
				},
				{
					value: "cirun-runner",
					providerId: "cirun",
					requires: enableGuard("CIRUN"),
				},
				{
					value: "actuated-4cpu-8gb",
					providerId: "actuated",
					requires: enableGuard("ACTUATED"),
				},
				{
					value: "cirrus-runner",
					providerId: "cirrus",
					requires: enableGuard("CIRRUS"),
				},
				{
					value: "warp-ubuntu-latest-x64-2x",
					providerId: "warpbuild",
					requires: enableGuard("WARPBUILD"),
				},
				{
					value: "buildjet-2vcpu-ubuntu-2204",
					providerId: "buildjet",
					requires: enableGuard("BUILDJET"),
				},
				{
					value: "nscloud-ubuntu-24.04-amd64-2x4",
					providerId: "namespace",
					requires: enableGuard("NAMESPACE"),
				},
				{
					value: "depot-ubuntu-24.04",
					providerId: "depot",
					requires: enableGuard("DEPOT"),
				},
				{
					// Final backup: the machine requesting CI. No enable guard —
					// it must stay reachable exactly when everything else is
					// blocked. Jobs routed here queue until the requester runs
					// `pnpm --filter @hobo/example-ci-runner-balancing host-runner`.
					value: "hobo-last-resort",
					providerId: "requesting_machine",
					requires: [],
					lastResort: true,
				},
			],
		},
	],
	envelopes: [
		{ providerId: "github_hosted", softCapUsd: 25, hardCapUsd: 50 },
		{ providerId: "self_hosted", softCapUsd: 5, hardCapUsd: 10 },
		{ providerId: "requesting_machine", softCapUsd: 5, hardCapUsd: 10 },
		{ providerId: "namespace", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "buildjet", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "actuated", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "warpbuild", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "blacksmith", softCapUsd: 20, hardCapUsd: 40 },
		{ providerId: "ubicloud", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "runs_on", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "cirun", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "depot", softCapUsd: 10, hardCapUsd: 20 },
		{ providerId: "cirrus", softCapUsd: 10, hardCapUsd: 20 },
	],
};
