/**
 * The runner types a runner order can name, and the labels each one answers
 * to.
 *
 * A step of the order is one of four kinds. `fleet` is the HoBo isolated
 * fleet: the relay starts a one-job runner in a fresh container or sandbox.
 * `machine` is capacity someone already owns: a connected workstation, or a
 * self-hosted runner that was registered before HoBo was. `github` is
 * GitHub's own machines. Everything else is a hosted provider whose own
 * GitHub App brings the runner once the job asks for one of its labels, so
 * for those HoBo only has to hand the job the right label.
 *
 * The label families below were read from each vendor's documentation on the
 * day in `observedAt`. They are routing input, never billing input: a label
 * a vendor has renamed makes the job wait for a runner that never comes,
 * which the provider-health record in `./health.ts` then notices.
 *
 * Pure data and pure functions: no clock, network or store.
 */

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

/** The key, when the text is one a step may carry. */
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

/** The size, when the number is one `auto` may ask for. */
export function runnerAutoSize(vcpus: number): RunnerAutoSize | undefined {
	return RUNNER_AUTO_SIZES.find((size) => size === vcpus);
}

/** Whether a provider runs jobs from public repositories. */
export type PublicRepositoryStance =
	| "yes"
	/** Off until the owner turns it on at the provider. */
	| "opt-in"
	/** The vendor's page was not read for this; nothing is assumed. */
	| "unstated";

export type RunnerProviderEntry = Readonly<{
	displayName: string;
	/**
	 * Lower-case prefixes of the labels this provider answers to. A prefix
	 * ending in `-` also matches the bare name (`depot-` matches `depot`).
	 */
	labelPrefixes: readonly string[];
	/**
	 * Linux x64 labels by vCPU count, smallest first. `{run}` stands for the
	 * workflow run id, which some providers put in the label.
	 */
	sizes: readonly Readonly<{ vcpus: number; label: string }>[];
	publicRepositories: PublicRepositoryStance;
	/** Vendor page the labels were read from. */
	source: string;
	/** The day that page was read. */
	observedAt: string;
}>;

const OBSERVED_AT = "2026-11-16";

/**
 * Hosted providers, keyed by id. Linux x64 on the vendor's current Ubuntu
 * image only: other images and architectures are named by writing the label
 * out instead of `auto`.
 */
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
			// Only the default machine's label has been read from the vendor
			// (the same reading `../fleet/models.ts` prices).
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

/**
 * GitHub-hosted Linux x64 labels by vCPU count for a private repository.
 * Never `ubuntu-latest`: a moving label changes the machine under a job
 * without a commit.
 */
export const GITHUB_HOSTED_SIZES: readonly Readonly<{
	vcpus: number;
	label: string;
}>[] = [{ vcpus: 2, label: "ubuntu-24.04" }];

const GITHUB_HOSTED_LABEL = /^(ubuntu|windows|macos)-[a-z0-9.-]+$/u;

/** A label GitHub's own runners answer to (`ubuntu-24.04`, `macos-15`, ...). */
export function isGithubHostedLabel(label: string): boolean {
	return GITHUB_HOSTED_LABEL.test(label.trim().toLowerCase());
}

function prefixMatches(prefix: string, label: string): boolean {
	if (label.startsWith(prefix)) return true;
	return prefix.endsWith("-") && label === prefix.slice(0, -1);
}

/** Whether `label` is one this hosted provider answers to. */
export function isProviderLabel(
	provider: HostedRunnerProvider,
	label: string,
): boolean {
	const lower = label.trim().toLowerCase();
	const entry = RUNNER_PROVIDER_CATALOG.get(provider);
	if (!entry) return false;
	return entry.labelPrefixes.some((prefix) => prefixMatches(prefix, lower));
}

/**
 * Which runner type a `runs-on` label belongs to: a hosted provider, `github`,
 * or nothing when the label is not one this catalog knows (a self-hosted
 * label, or a provider that is not listed).
 */
export function runnerProviderOfLabel(
	label: string,
): HostedRunnerProvider | "github" | undefined {
	const provider = HOSTED_RUNNER_PROVIDERS.find((candidate) =>
		isProviderLabel(candidate, label),
	);
	if (provider) return provider;
	return isGithubHostedLabel(label) ? "github" : undefined;
}

/**
 * The label that asks `key` for a machine of at least `vcpus`: its smallest
 * size at or above the request. Nothing when the provider has no machine that
 * large, or when the step has no sizes (`fleet` and `machine` take a job on
 * the machine they have).
 */
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
