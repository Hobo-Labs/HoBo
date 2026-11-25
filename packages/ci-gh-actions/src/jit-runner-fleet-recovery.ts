import { ACTIVE_STATES, type Lease } from "@hobo/ci";
import {
	decideGhostBoxRunnerBinding,
	type GithubJobBinding,
} from "./jit-runner-ghost.js";
import type { GithubRunnerPresence } from "./jit-runner-presence.js";
import { leaseIdFromBoxRunnerName } from "./job-runner-custody.js";

export type SharedLeaseHint = Readonly<{
	id: string;
	state: string;
	accountId: string;
}>;

export type FleetGhostRecoveryDecision =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "covered"; leaseId: string }>
	| Readonly<{
			kind: "defer";
			leaseId: string;
			reason: "peer_runner_online" | "minting_host_active";
	  }>
	| Readonly<{
			kind: "release";
			runnerName: string;
			runnerId: number;
			leaseId: string;
			role: "minting_host" | "fleet_witness";
	  }>;

function recoveryRole(
	sharedLease: SharedLeaseHint | undefined,
	localAccountId: string | undefined,
): "minting_host" | "fleet_witness" {
	if (
		sharedLease &&
		localAccountId &&
		sharedLease.accountId === localAccountId &&
		ACTIVE_STATES.has(sharedLease.state)
	)
		return "minting_host";
	return "fleet_witness";
}

/**
 * Fleet cooperation:
 * - **Minting host** — the worker whose shared relay lease for `hobo-<lease-uuid>`
 *   is still active normally owns container stop + deregister on reconcile.
 * - **Fleet witness** — any other box worker that sees `in_progress` on a box JIT
 *   runner it does not host may deregister only when GitHub reports the runner
 *   offline (crashed peer / network loss). Online runners are never touched.
 */
export function decideFleetGhostRecovery(
	job: Readonly<{ repositoryId: number; id: number; runAttempt: number }>,
	githubJob: GithubJobBinding,
	localActiveLeases: readonly Lease[],
	sharedLease: SharedLeaseHint | undefined,
	presence: GithubRunnerPresence | undefined,
	localAccountId: string | undefined,
): FleetGhostRecoveryDecision {
	const binding = decideGhostBoxRunnerBinding(
		job,
		githubJob,
		localActiveLeases,
	);
	if (binding.kind === "covered") return binding;
	if (binding.kind === "none") return { kind: "none" };
	const leaseId = leaseIdFromBoxRunnerName(binding.runnerName);
	if (!leaseId) return { kind: "none" };

	if (presence?.status === "online") {
		if (sharedLease && ACTIVE_STATES.has(sharedLease.state))
			return {
				kind: "defer",
				leaseId,
				reason: "minting_host_active",
			};
		return {
			kind: "defer",
			leaseId,
			reason: "peer_runner_online",
		};
	}

	if (presence?.status !== "offline") return { kind: "none" };

	return {
		kind: "release",
		runnerName: binding.runnerName,
		runnerId: binding.runnerId,
		leaseId,
		role: recoveryRole(sharedLease, localAccountId),
	};
}
