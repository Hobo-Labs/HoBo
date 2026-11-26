/**
 * Every case is a line in `reducer.cases.jsonl`.
 *
 * A reducer is the easiest thing in the repo to drive from data — a command
 * sequence *is* JSON — and the suite this replaced spent most of its length
 * re-typing the same five provisioning commands and the same
 * `try { reduce(…) } catch { return caught }` block to read one error code.
 * Both live here once.
 */

import { describeConcern } from "@hobo/contract-harness";
import {
	attachBundle,
	type ClaimBundle,
	type ClaimCommand,
	type ClaimCoordinatorState,
	type ClaimItem,
	claimAtomicityOf,
	type GuestLease,
	initialState,
	reduce,
} from "../src/index.js";

const FENCE = "fence-1";
const NOW = Date.UTC(2026, 7, 8, 12);

const BASE_ITEM: ClaimItem = {
	id: "item-cf",
	subjectRef: "yard://cloudflare/temp-1",
	subjectKind: "yard",
	providerId: "cloudflare",
	claimStrategyRef: "claim.cloudflare.temporary-account/v1",
	mode: "account-claim",
	deadline: NOW + 60 * 60 * 1000,
	continuity: {
		endpoint: "preserved",
		data: "preserved",
		credentials: "reauthorized",
	},
	creatorAuthorityAfterClaim: "reauthorization-required",
	verificationRef: "verify.cloudflare.account-ownership/v1",
	postClaimActions: [],
	completedPostClaimActions: [],
	status: "pending",
};

const LEASE: GuestLease = {
	schemaVersion: "hobo.guest-lease/v1",
	id: "lease-1",
	subjectRef: "yard://cloudflare/temp-1",
	bootstrapStrategyRef: "bootstrap.cloudflare.temporary-account/v1",
	bootstrapClass: "proof-of-work",
	createdAt: NOW,
	expiresAt: NOW + 60 * 60 * 1000,
	claimBy: NOW + 60 * 60 * 1000,
	renewable: false,
	renewalCount: 0,
	cleanupPolicy: "delete",
	status: "active",
	fencingToken: FENCE,
};

const toItems = (patches: readonly Partial<ClaimItem>[] = [{}]): ClaimItem[] =>
	patches.map((patch) => ({ ...BASE_ITEM, ...patch }));

function toBundle(items: readonly ClaimItem[]): ClaimBundle {
	return {
		schemaVersion: "hobo.claim-bundle/v1",
		id: "bundle-1",
		deploymentRef: "deployment-1",
		items,
		dependencyEdges: [],
		atomicity: claimAtomicityOf(items),
		compensation: {
			onTimeout: "destroy",
			onPartialClaim: "continue-and-repair",
			rollbackWindowMs: 3_600_000,
		},
		status: "pending",
	};
}

/** The five commands every claim case used to restate before its own. */
const PROVISIONING: readonly ClaimCommand[] = [
	{
		kind: "CompileDeploymentOffer",
		deploymentRef: "deployment-1",
		offerId: "offer-1",
	},
	{
		kind: "AcceptDeploymentOffer",
		offerId: "offer-1",
		offerDigest: "sha256:abc",
		acceptedAt: NOW,
	},
	{ kind: "ReserveGuestLease", lease: LEASE },
	{
		kind: "StartGuestDeployment",
		deploymentRef: "deployment-1",
		idempotencyKey: "k1",
	},
	{
		kind: "RecordProvisionedSubject",
		subjectRef: "yard://cloudflare/temp-1",
		subjectKind: "yard",
		providerId: "cloudflare",
		idempotencyKey: "k2",
	},
];

interface Ask {
	readonly items?: readonly Partial<ClaimItem>[];
	/** Fold onto a bare initial state instead of a provisioned bundle. */
	readonly bare?: boolean;
	readonly commands?: readonly ClaimCommand[];
	/**
	 * One further command, applied last and allowed to throw.
	 *
	 * Split from `commands` so a single case can pin the state a sequence
	 * reaches *and* the refusal that follows it, which the old suite needed a
	 * local try/catch block to express.
	 */
	readonly then?: ClaimCommand;
	readonly fencingToken?: string;
}

const fold = (
	state: ClaimCoordinatorState,
	commands: readonly ClaimCommand[],
	fencingToken: string,
) =>
	commands.reduce(
		(acc, command) => reduce(acc, command, { fencingToken }).state,
		state,
	);

function start(ask: Ask): ClaimCoordinatorState {
	const bare = initialState("deployment-1", FENCE);
	if (ask.bare) return bare;
	return attachBundle(
		fold(bare, PROVISIONING, FENCE),
		toBundle(toItems(ask.items)),
	);
}

/** Only what the cases assert on, so a case reads as a claim about behaviour. */
const project = (state: ClaimCoordinatorState, events: readonly unknown[]) => ({
	lifecycle: state.lifecycle,
	bundleStatus: state.bundle?.status ?? null,
	earliestDeadline: state.bundle?.earliestDeadline ?? null,
	agentAuthorized: state.agentAuthorized ?? null,
	leaseStatus: state.lease?.status ?? null,
	provisionedSubjects: state.provisionedSubjects,
	items: (state.bundle?.items ?? []).map((item) => ({
		id: item.id,
		status: item.status,
		creatorAuthorityAfterClaim: item.creatorAuthorityAfterClaim,
		// Projected to null so a case can assert "cleared"; JSON has no undefined.
		failureCode: item.failureCode ?? null,
	})),
	// SAFETY: `events: events.map((event) => (event as { kind: string }).kind),` is required at this I/O or test boundary.
	events: events.map((event) => (event as { kind: string }).kind),
});

function after(ask: Ask) {
	const fencingToken = ask.fencingToken ?? FENCE;
	const state = fold(start(ask), ask.commands ?? [], fencingToken);
	if (!ask.then) return project(state, []);
	const result = reduce(state, ask.then, { fencingToken });
	return project(result.state, result.events);
}

describeConcern("claim coordinator", {
	cases: `${import.meta.dirname}/reducer.cases.jsonl`,
	subject: () => ({
		after,
		/** Atomicity is a pure classification over the items alone. */
		atomicityOf: (patches: readonly Partial<ClaimItem>[]) =>
			claimAtomicityOf(toItems(patches)),
		/** Restart safety: the same sequence from the same start must land identically. */
		replaysIdentically: (ask: Ask) => {
			// Two independent folds, not one value compared to itself: the point
			// is that replaying a stream from scratch reconstructs the state.
			const first = JSON.stringify(after(ask));
			const second = JSON.stringify(after(ask));
			return first === second;
		},
		/** Redelivery must not move the bundle. */
		isIdempotentOn: (ask: Ask, command: ClaimCommand) => {
			const once = fold(start(ask), ask.commands ?? [], FENCE);
			const twice = fold(once, [command], FENCE);
			return JSON.stringify(twice.bundle) === JSON.stringify(once.bundle);
		},
	}),
});
