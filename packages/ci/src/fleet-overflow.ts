export type FleetBackend = "hobo" | "arc" | "local" | "github";

export type FleetMember = Readonly<{
	id: string;
	backend: FleetBackend;
	enabled: boolean;
	runsOn: string;
	freeSlots: number;
}>;

export type FleetSelection = Readonly<{
	backend: FleetBackend;
	runsOn: string;
	memberId: string;
	spilled: boolean;
}>;

// public-contract: the GitHub-hosted machine type overflow uses instead of ubuntu-latest.
export const DEFAULT_GITHUB_MACHINE_TYPE = "ubuntu-24.04";

const HOBO_JIT_LABELS = new Set(["hobo", "hobo-trunk"]);

// public-contract: the `runs-on` label a routed job asks a local box for.
export const LOCAL_HOST_RUNNER_LABEL = "hobo-local-host";

const OVERFLOW_BACKEND_ORDER: readonly FleetBackend[] = [
	"arc",
	"local",
	"github",
];

export function isGithubLatestLabel(runsOn: string): boolean {
	return runsOn.trim().toLowerCase() === "ubuntu-latest";
}

export function isOverflowRunnerLabel(labels: readonly string[]): boolean {
	if (labels.length !== 1) return false;
	const label = labels[0]?.trim().toLowerCase() ?? "";
	if (label.length === 0) return false;
	return !HOBO_JIT_LABELS.has(label);
}

function selectionOf(member: FleetMember, spilled: boolean): FleetSelection {
	return {
		backend: member.backend,
		runsOn: member.runsOn,
		memberId: member.id,
		spilled,
	};
}

function isOverflowBackend(backend: FleetBackend): boolean {
	return backend !== "hobo";
}

export function selectFleetBackend(input: {
	members: readonly FleetMember[];
	currentLabels: readonly string[];
}): FleetSelection | undefined {
	const boundLabels = new Set(
		input.currentLabels
			.map((label) => label.trim())
			.filter((label) => label.length > 0),
	);

	const bound = input.members.find(
		(member) =>
			isOverflowBackend(member.backend) && boundLabels.has(member.runsOn),
	);
	if (bound) return selectionOf(bound, true);

	const hobo = input.members.find(
		(member) =>
			member.backend === "hobo" && member.enabled && member.freeSlots > 0,
	);
	if (hobo) return selectionOf(hobo, false);

	const overflowEnabled = input.members.some(
		(member) => isOverflowBackend(member.backend) && member.enabled,
	);
	if (!overflowEnabled) return undefined;

	for (const backend of OVERFLOW_BACKEND_ORDER) {
		const member = input.members.find(
			(candidate) =>
				candidate.backend === backend &&
				candidate.enabled &&
				candidate.freeSlots > 0,
		);
		if (member) return selectionOf(member, true);
	}

	return undefined;
}

export function queuedDemandLabels(
	leaseProvider: string,
	offerBackend: string,
	offerRunsOn: string,
	originalLabels: readonly string[],
): string[] {
	const hostedGithub =
		leaseProvider === "github" &&
		(offerBackend === "gh-actions" || offerBackend === "") &&
		offerRunsOn.length > 0;
	const arc =
		offerBackend === "gh-actions" &&
		leaseProvider === "kubernetes" &&
		offerRunsOn !== "hobo-isolated-worker";
	if (hostedGithub || arc) return [offerRunsOn];

	const hoboLabel = originalLabels.find((label) =>
		HOBO_JIT_LABELS.has(label.trim().toLowerCase()),
	);
	return [hoboLabel ?? "hobo"];
}

export function shouldAbortIsolatedFleetLease(
	provider: string,
	offer?: { backend: string; runsOn: string },
): boolean {
	if (provider === "vercel" || provider === "hobo-box-worker") return true;
	if (provider !== "kubernetes" || !offer) return false;
	return isIsolatedFleetProvider(provider, offer.backend, offer.runsOn);
}

export function isIsolatedFleetProvider(
	provider: string,
	backend: string,
	runsOn: string,
): boolean {
	if (provider === "hobo-box-worker") return true;
	return (
		provider === "kubernetes" &&
		backend === "isolated-container" &&
		runsOn === "hobo-isolated-worker"
	);
}
