export type RunnerTier = "hobo" | "arc" | "local" | "github" | "agent37";

export type RunnerTierState = Readonly<{
	id: string;
	backend: RunnerTier;
	enabled: boolean;
	runsOn: string;
	freeSlots: number;
}>;

export type RunnerTierSelection = Readonly<{
	backend: RunnerTier;
	runsOn: string;
	memberId: string;
	spilled: boolean;
}>;

export const DEFAULT_GITHUB_MACHINE_TYPE = "ubuntu-24.04";

const HOBO_JIT_LABELS = new Set(["hobo", "hobo-trunk"]);

export const LOCAL_HOST_RUNNER_LABEL = "hobo-local-host";

const OVERFLOW_BACKEND_ORDER: readonly RunnerTier[] = [
	"arc",
	"local",
	"agent37",
	"github",
];
const VERIFICATION_BACKENDS: ReadonlySet<string> = new Set([
	"hobo",
	...OVERFLOW_BACKEND_ORDER,
]);

export function isGithubLatestLabel(runsOn: string): boolean {
	return runsOn.trim().toLowerCase() === "ubuntu-latest";
}

export function isOverflowRunnerLabel(labels: readonly string[]): boolean {
	if (labels.length !== 1) return false;
	const label = labels[0]?.trim().toLowerCase() ?? "";
	if (label.length === 0) return false;
	return !HOBO_JIT_LABELS.has(label);
}

function selectionOf(
	member: RunnerTierState,
	spilled: boolean,
): RunnerTierSelection {
	return {
		backend: member.backend,
		runsOn: member.runsOn,
		memberId: member.id,
		spilled,
	};
}

function isOverflowBackend(backend: RunnerTier): boolean {
	return backend !== "hobo";
}

export function selectRunnerTier(input: {
	members: readonly RunnerTierState[];
	currentLabels: readonly string[];
}): RunnerTierSelection | undefined {
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

export type Agent37PoolPolicy = Readonly<{
	labels: readonly string[];
	runnerNamePrefix: string;
	maxRunners: number;
}>;

export type Agent37PoolObservation = Readonly<{
	activeRunners: number;
}>;

export type Agent37Capacity = Readonly<{
	runsOn: string;
	runnerNamePrefix: string;
	freeRunners: number;
}>;

export function agent37Capacity(
	pool: Agent37PoolPolicy,
	observation: Agent37PoolObservation,
): Agent37Capacity | undefined {
	const runsOn = pool.labels[0] ?? "";
	if (
		!Number.isSafeInteger(pool.maxRunners) ||
		pool.maxRunners < 1 ||
		pool.maxRunners > 10_000 ||
		pool.labels.length < 1 ||
		pool.labels.length > 16 ||
		pool.labels.some((label) => label.trim().length === 0) ||
		runsOn.length === 0 ||
		pool.runnerNamePrefix.length < 1 ||
		pool.runnerNamePrefix.length > 128 ||
		!Number.isSafeInteger(observation.activeRunners) ||
		observation.activeRunners < 0
	)
		return undefined;
	const freeRunners = pool.maxRunners - observation.activeRunners;
	if (freeRunners < 1) return undefined;
	return { runsOn, runnerNamePrefix: pool.runnerNamePrefix, freeRunners };
}

export type RunnerVerificationSelection =
	| Readonly<{ kind: "runner"; runner: RunnerTierSelection }>
	| Readonly<{ kind: "local-signoff" }>
	| Readonly<{ kind: "wait"; reason: "availability-unknown" | "no-capacity" }>;

/**
 * Use the ordinary fleet order first. Offer local signoff only when all
 * enabled runner tiers were observed unavailable and the operator enabled it.
 * Unknown capacity is not evidence of an outage. This selects an independent
 * verification path; it never moves or completes an already queued job.
 */
export function selectRunnerVerification(input: {
	members: readonly RunnerTierState[];
	unknownMembers: readonly string[];
	localSignoffEnabled: boolean;
}): RunnerVerificationSelection {
	const tag = Object.prototype.toString;
	if (
		!Array.isArray(input.members) ||
		!Array.isArray(input.unknownMembers) ||
		(input.localSignoffEnabled !== true &&
			input.localSignoffEnabled !== false) ||
		input.members.some(
			(member) =>
				tag.call(member) !== "[object Object]" ||
				(member.enabled !== true && member.enabled !== false) ||
				tag.call(member.id) !== "[object String]" ||
				member.id.trim().length === 0 ||
				(member.enabled &&
					(!VERIFICATION_BACKENDS.has(member.backend) ||
						tag.call(member.runsOn) !== "[object String]" ||
						member.runsOn.trim().length === 0)) ||
				(member.enabled &&
					(!Number.isSafeInteger(member.freeSlots) || member.freeSlots < 0)) ||
				(member.enabled &&
					member.freeSlots > 0 &&
					input.unknownMembers.includes(member.id)),
		)
	)
		return { kind: "wait", reason: "availability-unknown" };
	const ids = new Set(input.members.map((member) => member.id));
	if (
		ids.size !== input.members.length ||
		input.unknownMembers.some((id) => !ids.has(id))
	)
		return { kind: "wait", reason: "availability-unknown" };
	const runner = selectRunnerTier({
		members: input.members,
		currentLabels: [],
	});
	if (runner) return { kind: "runner", runner };
	if (
		input.members.some(
			(member) => member.enabled && input.unknownMembers.includes(member.id),
		)
	)
		return { kind: "wait", reason: "availability-unknown" };
	return input.localSignoffEnabled
		? { kind: "local-signoff" }
		: { kind: "wait", reason: "no-capacity" };
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
export function shouldAbortIsolatedLease(
	provider: string,
	offer?: { backend: string; runsOn: string },
): boolean {
	if (provider === "vercel" || provider === "hobo-box-worker") return true;
	if (provider !== "kubernetes" || !offer) return false;
	return isIsolatedProvider(provider, offer.backend, offer.runsOn);
}

export function isIsolatedProvider(
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
