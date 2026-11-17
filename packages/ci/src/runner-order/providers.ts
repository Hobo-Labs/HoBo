// public-contract: the hosted providers a runner order can name.
export const HOSTED_RUNNER_PROVIDERS = [
	"blacksmith",
	"depot",
	"namespace",
	"warpbuild",
	"ubicloud",
	"boat",
	"runs-on",
] as const;
export type HostedRunnerProvider = (typeof HOSTED_RUNNER_PROVIDERS)[number];

// public-contract: every key a runner-order step or a relay input can carry.
export const RUNNER_STEP_KEYS = [
	"fleet",
	"machine",
	"github",
	...HOSTED_RUNNER_PROVIDERS,
] as const;
export type RunnerStepKey = (typeof RUNNER_STEP_KEYS)[number];

const HOSTED: ReadonlySet<string> = new Set(HOSTED_RUNNER_PROVIDERS);

export function runnerStepKey(text: string): RunnerStepKey | undefined {
	return RUNNER_STEP_KEYS.find((key) => key === text);
}

export function isHostedRunnerProvider(
	key: RunnerStepKey,
): key is HostedRunnerProvider {
	return HOSTED.has(key);
}

// public-contract: the machine sizes an `auto` relay input can ask for, in vCPUs.
export const RUNNER_AUTO_SIZES = [2, 4, 8, 16, 32] as const;
export type RunnerAutoSize = (typeof RUNNER_AUTO_SIZES)[number];
// public-contract: the size `auto` means when the order names none.
export const DEFAULT_RUNNER_AUTO_SIZE: RunnerAutoSize = 2;

export function runnerAutoSize(vcpus: number): RunnerAutoSize | undefined {
	return RUNNER_AUTO_SIZES.find((size) => size === vcpus);
}

export type PublicRepositoryStance = "yes" | "opt-in" | "unstated";

export type RunnerProviderEntry = Readonly<{
	displayName: string;
	labelPrefixes: readonly string[];
	sizes: readonly Readonly<{ vcpus: number; label: string }>[];
	publicRepositories: PublicRepositoryStance;
	source: string;
	observedAt: string;
}>;

const OBSERVED_AT = "2026-11-16";

export const RUNNER_PROVIDER_CATALOG: ReadonlyMap<
	HostedRunnerProvider,
	RunnerProviderEntry
> = new Map<HostedRunnerProvider, RunnerProviderEntry>([
	[
		"blacksmith",
		{
			displayName: "Blacksmith",
			labelPrefixes: ["blacksmith-"],
			sizes: [2, 4, 8, 16, 32].map((vcpus) => ({
				vcpus,
				label: `blacksmith-${vcpus}vcpu-ubuntu-2404`,
			})),
			publicRepositories: "yes",
			source: "https://docs.blacksmith.sh/blacksmith-runners/overview",
			observedAt: OBSERVED_AT,
		},
	],
	[
		"depot",
		{
			displayName: "Depot",
			labelPrefixes: ["depot-"],
			sizes: [2, 4, 8, 16, 32, 64].map((vcpus) => ({
				vcpus,
				label:
					vcpus === 2 ? "depot-ubuntu-24.04" : `depot-ubuntu-24.04-${vcpus}`,
			})),
			publicRepositories: "opt-in",
			source: "https://depot.dev/docs/github-actions/runner-types",
			observedAt: OBSERVED_AT,
		},
	],
	[
		"namespace",
		{
			displayName: "Namespace",
			labelPrefixes: ["nscloud-", "namespace-profile-"],
			sizes: [2, 4, 8, 16, 32].map((vcpus) => ({
				vcpus,
				label: `nscloud-ubuntu-24.04-amd64-${vcpus}x${vcpus * 2}`,
			})),
			publicRepositories: "unstated",
			source:
				"https://namespace.so/docs/reference/github-actions/runner-configuration",
			observedAt: OBSERVED_AT,
		},
	],
	[
		"warpbuild",
		{
			displayName: "WarpBuild",
			labelPrefixes: ["warp-"],
			sizes: [2, 4, 8, 16, 32].map((vcpus) => ({
				vcpus,
				label: `warp-ubuntu-2404-x64-${vcpus}x`,
			})),
			publicRepositories: "unstated",
			source: "https://www.warpbuild.com/docs/ci/cloud-runners",
			observedAt: OBSERVED_AT,
		},
	],
	[
		"ubicloud",
		{
			displayName: "Ubicloud",
			labelPrefixes: ["ubicloud-"],
			sizes: [2, 4, 8, 16, 30].map((vcpus) => ({
				vcpus,
				label: `ubicloud-standard-${vcpus}`,
			})),
			publicRepositories: "unstated",
			source: "https://ubicloud.com/docs/about/pricing.md",
			observedAt: OBSERVED_AT,
		},
	],
	[
		"boat",
		{
			displayName: "Boat",
			labelPrefixes: ["boat-"],

			sizes: [{ vcpus: 4, label: "boat" }],
			publicRepositories: "opt-in",
			source: "https://docs.boat.dev/pricing.md",
			observedAt: "2026-11-09",
		},
	],
	[
		"runs-on",
		{
			displayName: "RunsOn",
			labelPrefixes: ["runs-on=", "runs-on/"],
			sizes: [2, 4, 8, 16, 32, 48, 64].map((vcpus) => ({
				vcpus,
				label: `runs-on={run}/runner=${vcpus}cpu-linux-x64`,
			})),
			publicRepositories: "unstated",
			source: "https://runs-on.com/docs/runners/platforms/linux/",
			observedAt: OBSERVED_AT,
		},
	],
]);

export const GITHUB_HOSTED_SIZES: readonly Readonly<{
	vcpus: number;
	label: string;
}>[] = [{ vcpus: 2, label: "ubuntu-24.04" }];

const GITHUB_HOSTED_LABEL = /^(ubuntu|windows|macos)-[a-z0-9.-]+$/u;

export function isGithubHostedLabel(label: string): boolean {
	return GITHUB_HOSTED_LABEL.test(label.trim().toLowerCase());
}

function prefixMatches(prefix: string, label: string): boolean {
	if (label.startsWith(prefix)) return true;
	return prefix.endsWith("-") && label === prefix.slice(0, -1);
}

export function isProviderLabel(
	provider: HostedRunnerProvider,
	label: string,
): boolean {
	const lower = label.trim().toLowerCase();
	const entry = RUNNER_PROVIDER_CATALOG.get(provider);
	if (!entry) return false;
	return entry.labelPrefixes.some((prefix) => prefixMatches(prefix, lower));
}

export function runnerProviderOfLabel(
	label: string,
): HostedRunnerProvider | "github" | undefined {
	const provider = HOSTED_RUNNER_PROVIDERS.find((candidate) =>
		isProviderLabel(candidate, label),
	);
	if (provider) return provider;
	return isGithubHostedLabel(label) ? "github" : undefined;
}

export function runnerLabelForSize(
	key: RunnerStepKey,
	vcpus: number,
	runId: number,
): string | undefined {
	const sizes =
		key === "github"
			? GITHUB_HOSTED_SIZES
			: key === "fleet" || key === "machine"
				? []
				: (RUNNER_PROVIDER_CATALOG.get(key)?.sizes ?? []);
	const fit = sizes.find((size) => size.vcpus >= vcpus);
	return fit?.label.replace("{run}", String(runId));
}
