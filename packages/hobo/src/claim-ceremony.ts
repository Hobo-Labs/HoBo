import {
	type ClaimBundle,
	ClaimError,
	type ClaimItem,
	outstandingObligations,
} from "@hobo/claims";
import type { CliContext, CommandResult, YardRuntime } from "@hobo/cli";
import { deploymentIdFor } from "@hobo/cli";
import { defaultHoboHome } from "./bare-metal-yard.js";
import {
	applyClaimCommand,
	claimStatusView,
	rebuildClaimState,
	requireItem,
} from "./claim-plane.js";
import { isJsonString, type JsonObject } from "./json.js";
import { createFileOneTimeActionStore } from "./one-time-action-store-file.js";

// The ownership ceremony verbs.
//
//   hobo claim status                what is outstanding, per item, with clocks
//   hobo claim open <item>           redeem the one-time action for one item
//   hobo claim finalize <item>       verify ownership and discharge obligations
//
// These are separate from `hobo claim <account>`, which rebinds a HoBo
// deployment's owner. Provider ownership is a different state machine: the
// human can own the infrastructure while the agent is revoked, and both facts
// have to be representable.

export interface ClaimCeremonyInput {
	readonly subcommand: "status" | "open" | "finalize";
	readonly args: readonly string[];
	readonly flags: JsonObject;
	readonly context: CliContext;
	readonly deps: {
		readonly runtime?: YardRuntime;
		readonly env?: NodeJS.ProcessEnv;
		readonly now?: () => number;
		readonly bundle?: ClaimBundle;
		readonly verifyOwnership?: ClaimOwnershipVerifier;
	};
}

export type ClaimOwnershipVerifier = (input: {
	readonly item: ClaimItem;
	readonly nowMs: number;
	// Where the item's one-time actions live, for a verifier that must redeem
	// HoBo's own revocation material (a secret store's bootstrap token).
	readonly deploymentRef?: string;
	readonly home?: string;
}) => Promise<{ readonly verified: boolean; readonly evidenceRef: string }>;

export async function runClaimCeremony(
	input: ClaimCeremonyInput,
): Promise<CommandResult> {
	const { runtime } = input.deps;
	if (runtime === undefined) {
		return {
			ok: false,
			status: "unavailable",
			code: "HOBO_NO_RUNTIME",
			message:
				"hobo claim has no Yard runtime wired — run it from the composed `hobo` binary.",
			data: { command: "claim", subcommand: input.subcommand },
		};
	}

	const env = input.deps.env ?? process.env;
	const nowMs = input.deps.now?.() ?? Date.now();
	const projectDir =
		input.context.projectDir ??
		(isJsonString(input.flags.cwd) ? input.flags.cwd : input.context.cwd);
	const deploymentRef = deploymentIdFor(projectDir);
	const home =
		isJsonString(input.flags.home) && input.flags.home.length > 0
			? input.flags.home
			: defaultHoboHome(env);

	// The fence is the lease's, once a lease exists. Before then a rebuild
	// establishes it, and a mismatch is what stops a stale worker from acting.
	const bootstrapFence = `${deploymentRef}:0`;
	let snapshot = await rebuildClaimState(
		runtime,
		deploymentRef,
		bootstrapFence,
	);
	if (snapshot.state.bundle === undefined && input.deps.bundle !== undefined) {
		const attached = await applyClaimCommand(runtime, snapshot, {
			kind: "AttachClaimBundle",
			bundle: input.deps.bundle,
		});
		snapshot = {
			...snapshot,
			state: attached.state,
			seq: attached.seq,
			commandCount: snapshot.commandCount + 1,
		};
	}

	if (snapshot.commandCount === 0) {
		return {
			ok: false,
			status: "no_claim_bundle",
			code: "HOBO_CLAIM_NO_BUNDLE",
			message: `hobo claim ${input.subcommand}: no claim bundle for "${deploymentRef}".`,
			remediation: [
				"Run `hobo offer <recipe-id>` and accept it, then deploy, to create a claim bundle.",
			],
			data: { command: "claim", subcommand: input.subcommand, deploymentRef },
		};
	}
	const itemId = input.args[0];
	if (itemId === undefined && input.subcommand !== "status") {
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CLAIM_USAGE",
			message: `hobo claim ${input.subcommand} <item-id>`,
			remediation: ["Run `hobo claim status` to list item ids."],
			data: { command: "claim", subcommand: input.subcommand },
		};
	}
	if (snapshot.state.bundle === undefined) {
		return {
			ok: false,
			status: "repair_required",
			code: "HOBO_CLAIM_BUNDLE_MISSING",
			message: `hobo claim ${input.subcommand}: durable claim commands exist, but the claim bundle is missing.`,
			remediation: [
				"Recreate the claim bundle from the deployment offer before continuing.",
			],
			data: { command: "claim", subcommand: input.subcommand, deploymentRef },
		};
	}

	if (input.subcommand === "status") {
		const view = claimStatusView(snapshot.state);
		const outstanding = view.items.filter(
			(item) => item.status !== "completed",
		);
		return {
			ok: true,
			status: outstanding.length === 0 ? "complete" : "outstanding",
			code: "HOBO_CLAIM_STATUS",
			message:
				outstanding.length === 0
					? `hobo claim status: every item in ${view.bundleId ?? "the bundle"} is complete.`
					: `hobo claim status: ${outstanding.length} of ${view.items.length} item(s) outstanding${
							view.earliestDeadline !== null
								? `, earliest deadline ${view.earliestDeadline}`
								: ""
						}.`,
			data: { command: "claim", subcommand: "status", ...view },
		};
	}

	if (itemId === undefined)
		throw new ClaimError("CLAIM_REPAIR_REQUIRED", "claim item id missing");

	try {
		const item = requireItem(snapshot.state, itemId);

		if (input.subcommand === "open") {
			if (item.oneTimeActionRef === undefined) {
				return {
					ok: false,
					status: "no_action",
					code: "HOBO_CLAIM_NO_ACTION",
					message: `hobo claim open: item ${itemId} has no pending one-time action.`,
					remediation:
						item.status === "completed"
							? ["This item is already complete."]
							: [
									"Run `hobo claim status` to see what this item is waiting on.",
								],
					data: {
						command: "claim",
						subcommand: "open",
						itemId,
						status: item.status,
					},
				};
			}
			if (item.deadline !== undefined && item.deadline <= nowMs) {
				return {
					ok: false,
					status: "expired",
					code: "CLAIM_EXPIRED",
					message: `hobo claim open: the ownership action for ${itemId} expired at ${item.deadline}.`,
					remediation: [
						"Redeploy to obtain a fresh claim action, or accept expiry cleanup.",
					],
					data: { command: "claim", subcommand: "open", itemId },
				};
			}

			const store = createFileOneTimeActionStore({ home });
			const redeemed = await store.redeem({
				id: item.oneTimeActionRef,
				tenantId: env.HOBO_TENANT ?? "default",
				projectId: env.HOBO_PROJECT ?? deploymentRef,
				sessionId: deploymentRef,
				audience: item.providerId,
				now: nowMs,
			});

			// Observation only. A provider's redirect says a human went to the
			// page; it does not say ownership moved, and treating it as proof is
			// exactly the failure this state machine exists to prevent.
			const observed = await applyClaimCommand(runtime, snapshot, {
				kind: "ObserveClaimItem",
				itemId,
				observedStatus: "pending",
				at: nowMs,
			});

			return {
				ok: true,
				status: "opened",
				code: "HOBO_CLAIM_OPENED",
				message: `hobo claim open: complete the ${item.providerId} ownership step, then run \`hobo claim finalize ${itemId}\`.`,
				data: {
					command: "claim",
					subcommand: "open",
					itemId,
					providerId: item.providerId,
					// The bearer URL is returned to the caller once and never
					// persisted; the durable record holds only the action ref.
					actionUrl: redeemed.value,
					deadline: item.deadline ?? null,
					lifecycle: observed.state.lifecycle,
				},
			};
		}

		// finalize
		if (input.deps.verifyOwnership === undefined) {
			return {
				ok: false,
				status: "unavailable",
				code: "HOBO_CLAIM_VERIFIER_UNAVAILABLE",
				message: `hobo claim finalize: no independent provider verifier is configured for ${itemId}.`,
				remediation: [
					"Configure the provider ownership verifier, then retry finalize.",
				],
				data: { command: "claim", subcommand: "finalize", itemId },
			};
		}
		const verification = await input.deps.verifyOwnership({
			item,
			nowMs,
			deploymentRef,
			home,
		});
		const verified = await applyClaimCommand(runtime, snapshot, {
			kind: "VerifyOwnership",
			itemId,
			verified: verification.verified,
			evidenceRef: verification.evidenceRef,
			creatorAuthorityAfterClaim: item.creatorAuthorityAfterClaim,
		});
		// The seq comes back from the append rather than being guessed: verifying
		// ownership emits a fact, so the stream advanced by more than one and the
		// CompleteClaimItem below would otherwise be rejected as stale.
		snapshot = { ...snapshot, state: verified.state, seq: verified.seq };

		const pending = outstandingObligations(requireItem(snapshot.state, itemId));
		if (pending.length > 0) {
			return {
				ok: false,
				status: "obligations_outstanding",
				code: "HOBO_CLAIM_OBLIGATIONS",
				message: `hobo claim finalize: ownership verified for ${itemId}, but ${pending.length} post-claim obligation(s) remain.`,
				remediation: pending.map(
					(action) => `Discharge ${action} before this item can complete.`,
				),
				data: {
					command: "claim",
					subcommand: "finalize",
					itemId,
					outstandingObligations: pending,
					lifecycle: snapshot.state.lifecycle,
				},
			};
		}

		const completed = await applyClaimCommand(runtime, snapshot, {
			kind: "CompleteClaimItem",
			itemId,
			at: nowMs,
		});
		const view = claimStatusView(completed.state);
		return {
			ok: true,
			status: "finalized",
			code: "HOBO_CLAIM_FINALIZED",
			message: `hobo claim finalize: ${itemId} is owned and verified (${view.items.filter((entry) => entry.status !== "completed").length} item(s) still outstanding).`,
			data: { command: "claim", subcommand: "finalize", itemId, ...view },
		};
	} catch (error) {
		if (error instanceof ClaimError) {
			return {
				ok: false,
				status: "claim_failed",
				code: error.code,
				message: `hobo claim ${input.subcommand}: ${error.message}`,
				remediation: [
					"Run `hobo claim status` to see the current bundle state.",
				],
				data: { command: "claim", subcommand: input.subcommand, itemId },
			};
		}
		throw error;
	}
}
