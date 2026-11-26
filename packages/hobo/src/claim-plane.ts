import {
	assertNoSecrets,
	attachBundle,
	type ClaimBundle,
	type ClaimCommand,
	type ClaimCoordinatorState,
	ClaimError,
	type ClaimEvent,
	type ClaimItem,
	initialState,
	outstandingObligations,
	reduce,
} from "@hobo/claims";
import type { YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT } from "@hobo/cli";
import { collectStream } from "@hobo/cloud";
import type { JsonObject } from "./json.js";

// The durable side of the claim plane.
//
// `@hobo/claims` is a pure reducer: it takes a command and returns the next
// state plus the facts that command produced. It deliberately owns no storage.
// This module is where those facts become durable, on the same fenced event
// store `hobo up` writes to.
//
// Both halves are persisted. The command journal is what the state is rebuilt
// from — `reduce` is pure, so replaying commands is deterministic — and the
// emitted events are the published facts every projection and subscriber
// reads. Persisting only the events would leave nothing to rebuild from;
// persisting only the commands would leave subscribers with nothing to watch.

// public-contract: persisted claim journals replay this event type.
export const CLAIM_COMMAND_EVENT = "claim.CommandApplied";
// public-contract: claim-plane readers use this namespace to identify facts.
export const CLAIM_FACT_PREFIX = "claim.";

export function claimStreamFor(deploymentRef: string): string {
	return `claim:${deploymentRef}`;
}

type StoredCommand = {
	readonly command: ClaimCommand;
	readonly fencingToken: string;
};

export interface ClaimPlaneSnapshot {
	readonly state: ClaimCoordinatorState;
	/** Store sequence the snapshot was folded at, for optimistic append. */
	readonly seq: number;
	readonly commandCount: number;
}

/**
 * Rebuild coordinator state from the durable command journal.
 *
 * A bundle attached out of band (the compiler's typed bundle) is re-attached
 * before replay so item-scoped commands have items to address.
 */
export async function rebuildClaimState(
	runtime: YardRuntime,
	deploymentRef: string,
	fencingToken: string,
	bundle?: ClaimBundle,
): Promise<ClaimPlaneSnapshot> {
	const stream = claimStreamFor(deploymentRef);
	const envelopes = await collectStream(runtime.store, stream);
	let state = initialState(deploymentRef, fencingToken);
	if (bundle !== undefined) {
		state = attachBundle(state, bundle);
	}
	let commandCount = 0;
	let seq = 0;
	for (const envelope of envelopes) {
		// SAFETY: assertion required at this I/O or test boundary.
		seq = Math.max(seq, (envelope as { seq?: number }).seq ?? seq);
		if (envelope.type !== CLAIM_COMMAND_EVENT) continue;
		// SAFETY: assertion required at this I/O or test boundary.
		const stored = (envelope as { data?: StoredCommand }).data;
		if (stored === undefined) continue;
		state = reduce(state, stored.command, {
			fencingToken: stored.fencingToken,
		}).state;
		commandCount += 1;
	}
	return { state, seq, commandCount };
}

export interface ApplyClaimCommandResult {
	readonly state: ClaimCoordinatorState;
	readonly events: readonly ClaimEvent[];
	/**
	 * The stream sequence after the append, for a caller that applies a second
	 * command without re-reading. One command is one envelope *plus one per
	 * emitted fact*, so a caller that assumed `+1` would send a stale
	 * `expectedSeq` on its next append and be rejected.
	 */
	readonly seq: number;
}

/**
 * Apply one command and make it durable.
 *
 * The secret guard runs on every emitted fact before the append, not only in
 * tests: a claim URL or a connection string in a durable payload cannot be
 * taken back once it is written.
 */
export async function applyClaimCommand(
	runtime: YardRuntime,
	snapshot: ClaimPlaneSnapshot,
	command: ClaimCommand,
): Promise<ApplyClaimCommandResult> {
	const result = reduce(snapshot.state, command, {
		fencingToken: snapshot.state.fencingToken,
	});
	for (const event of result.events) {
		assertNoSecrets(event);
	}
	const stream = claimStreamFor(snapshot.state.deploymentRef);
	await runtime.store.append(
		stream,
		[
			{
				type: CLAIM_COMMAND_EVENT,
				data: {
					command,
					fencingToken: snapshot.state.fencingToken,
				} satisfies StoredCommand,
			},
			...result.events.map((event) => ({
				type: `${CLAIM_FACT_PREFIX}${event.type}`,
				// SAFETY: assertion required at this I/O or test boundary.
				data: event as JsonObject,
			})),
		],
		{
			expectedSeq: snapshot.seq,
			// The claim plane acts as the control plane itself: the human's
			// ownership is recorded in the facts, not in who appended them.
			actor: { kind: "service", id: "hobo.claim-coordinator" },
			tenant: DEFAULT_TENANT,
		},
	);
	return { ...result, seq: snapshot.seq + 1 + result.events.length };
}

export interface ClaimItemView {
	readonly itemId: string;
	readonly subjectRef: string;
	readonly providerId: string;
	readonly status: ClaimItem["status"];
	readonly mode: ClaimItem["mode"];
	readonly deadline: number | null;
	readonly creatorAuthorityAfterClaim: ClaimItem["creatorAuthorityAfterClaim"];
	/** Post-claim work that must finish before this item may complete. */
	readonly outstandingObligations: readonly string[];
	readonly hasOneTimeAction: boolean;
}

export interface ClaimStatusView {
	readonly deploymentRef: string;
	readonly lifecycle: ClaimCoordinatorState["lifecycle"];
	readonly leaseId: string | null;
	readonly leaseExpiresAt: number | null;
	readonly bundleId: string | null;
	readonly atomicity: ClaimBundle["atomicity"] | null;
	readonly bundleStatus: ClaimBundle["status"] | null;
	readonly earliestDeadline: number | null;
	readonly items: readonly ClaimItemView[];
	readonly agentAuthorized: boolean;
}

/**
 * The read model `hobo claim status` renders.
 *
 * Deadlines and obligations are reported per item rather than collapsed into
 * one green check: a bundle with two providers has two clocks, and hiding the
 * second is how a partial claim gets reported as done.
 */
export function claimStatusView(state: ClaimCoordinatorState): ClaimStatusView {
	const bundle = state.bundle;
	const items = (bundle?.items ?? []).map(
		(item): ClaimItemView => ({
			itemId: item.id,
			subjectRef: item.subjectRef,
			providerId: item.providerId,
			status: item.status,
			mode: item.mode,
			deadline: item.deadline ?? null,
			creatorAuthorityAfterClaim: item.creatorAuthorityAfterClaim,
			outstandingObligations: outstandingObligations(item),
			hasOneTimeAction: item.oneTimeActionRef !== undefined,
		}),
	);
	const deadlines = items
		.map((item) => item.deadline)
		.filter((deadline): deadline is number => deadline !== null)
		.sort((left, right) => left - right);
	return {
		deploymentRef: state.deploymentRef,
		lifecycle: state.lifecycle,
		leaseId: state.lease?.id ?? null,
		leaseExpiresAt: state.lease?.expiresAt ?? null,
		bundleId: bundle?.id ?? null,
		atomicity: bundle?.atomicity ?? null,
		bundleStatus: bundle?.status ?? null,
		earliestDeadline: deadlines[0] ?? null,
		items,
		agentAuthorized: state.agentAuthorized,
	};
}

export function requireItem(
	state: ClaimCoordinatorState,
	itemId: string,
): ClaimItem {
	const item = state.bundle?.items.find((candidate) => candidate.id === itemId);
	if (item === undefined) {
		throw new ClaimError(
			"CLAIM_REPAIR_REQUIRED",
			`no claim item ${itemId} in this deployment's bundle`,
		);
	}
	return item;
}
