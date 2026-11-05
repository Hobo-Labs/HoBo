/**
 * Pure fleet admission: prefer the hobo fleet, spill to ARC then GitHub-hosted
 * only when those overflow members are enabled and have free slots.
 * No I/O. Callers pass already-resolved member capacity.
 */

export type FleetBackend = "hobo" | "arc" | "github";

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

/** Concrete GitHub-hosted default. Never ubuntu-latest. */
// public-contract: the GitHub-hosted machine type overflow uses instead of ubuntu-latest.
export const DEFAULT_GITHUB_MACHINE_TYPE = "ubuntu-24.04";

const HOBO_JIT_LABELS = new Set(["hobo", "hobo-trunk"]);

const OVERFLOW_BACKEND_ORDER: readonly FleetBackend[] = ["arc", "github"];

export function isGithubLatestLabel(runsOn: string): boolean {
	return runsOn.trim().toLowerCase() === "ubuntu-latest";
}

/**
 * Overflow labels never enter hobo JIT admission.
 * True when the sole label is a concrete ARC scale-set name or GitHub-hosted
 * machine type (anything other than the hobo / hobo-trunk admission labels).
 */
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
	return backend === "arc" || backend === "github";
}

/**
 * Prefer hobo when it has free slots; else the first enabled overflow member
 * with freeSlots > 0, ARC before GitHub-hosted.
 * Config off (no enabled overflow) → hobo, or undefined when hobo is also empty.
 * Already-bound overflow labels stay on that member (no re-relay back to hobo).
 */
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

/**
 * Labels stamped onto queued demand for a relayed job.
 * GitHub-hosted and ARC (kubernetes + gh-actions, not the isolated worker label)
 * keep the concrete runs-on label so a later hobo pass cannot re-relay them.
 * Everything else stays on hobo / hobo-trunk.
 */
export function queuedDemandLabels(
	leaseProvider: string,
	offerBackend: string,
	offerRunsOn: string,
	originalLabels: readonly string[],
): string[] {
	// GitHub-hosted offers often omit backend (empty means gh-actions). ARC must
	// be an explicit gh-actions backend so an isolated worker label is not stamped.
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

/**
 * Isolated abort covers Vercel Sandbox and the box worker always.
 * Kubernetes is aborted only when the offer proves isolated-container.
 * An unknown kubernetes backend is left alone so ARC cannot requeue-loop.
 */
export function shouldAbortIsolatedFleetLease(
	provider: string,
	offer?: { backend: string; runsOn: string },
): boolean {
	if (provider === "vercel" || provider === "hobo-box-worker") return true;
	if (provider !== "kubernetes" || !offer) return false;
	return isIsolatedFleetProvider(provider, offer.backend, offer.runsOn);
}

/**
 * Isolated fleet hosts are the box worker and the kubernetes isolated-container
 * offer pinned to hobo-isolated-worker. Kubernetes + gh-actions (ARC) is shared
 * overflow capacity and must not be treated as isolated.
 */
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
