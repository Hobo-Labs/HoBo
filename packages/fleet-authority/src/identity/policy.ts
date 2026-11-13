/**
 * The authority's `PolicyEngine` (§6.13): role-based, from tags. A subject is
 * allowed an action when it carries `fleet-admin`, or a tag equal to the
 * action, or a tag a configured grant maps to the action (for example a
 * device's `role:<n>` to `fleet.member.declare`). Everything else is denied,
 * so a missing grant fails closed. Fleet policy, residency and dual control
 * are checked by the commands themselves; this engine only answers "may this
 * principal ask".
 */
import { allowDecision, denyDecision, type PolicyEngine } from "@hobo/core";
import { Role } from "@hobo/fleet";

// public-contract: the tag that may take every governed action (§6.13).
export const ADMIN_TAG = "fleet-admin";
// public-contract: the engine id recorded in every policy.Decided event.
export const ENGINE_ID = "hobo-fleet-authority/tags/v1";

// domain-view: one configured grant, a tag allowed some actions.
export type TagGrant = Readonly<{ tag: string; actions: readonly string[] }>;

/** A device holding any role in a fleet may sponsor its backends (§6.5 "Sponsors"). */
export const DEFAULT_GRANTS: readonly TagGrant[] = [
	Role.EXECUTOR,
	Role.DISPATCHER,
	Role.OBSERVER,
	Role.RECONCILER,
	Role.JUNCTION,
].map((role) => ({ tag: `role:${role}`, actions: ["fleet.member.declare"] }));

export function createTagPolicyEngine(
	grants: readonly TagGrant[] = DEFAULT_GRANTS,
): PolicyEngine {
	return {
		engineId: ENGINE_ID,
		async evaluate(request) {
			const tags = request.subject.tags;
			if (tags.includes(ADMIN_TAG))
				return allowDecision(ENGINE_ID, request, [
					`${ADMIN_TAG} may ${request.action}`,
				]);
			if (tags.includes(request.action))
				return allowDecision(ENGINE_ID, request, [`tag ${request.action}`]);
			const grant = grants.find(
				(candidate) =>
					tags.includes(candidate.tag) &&
					candidate.actions.includes(request.action),
			);
			return grant === undefined
				? denyDecision(ENGINE_ID, request, [
						`no tag of the subject allows ${request.action}`,
					])
				: allowDecision(ENGINE_ID, request, [
						`${grant.tag} may ${request.action}`,
					]);
		},
	};
}
