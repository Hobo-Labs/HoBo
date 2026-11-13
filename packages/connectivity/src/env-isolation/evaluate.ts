/**
 * Shared env-isolation evaluation used by TagAcl and rego-lite paths.
 * Fail closed; network membership is a signal only.
 */

import type { PolicyRequest } from "@hobo/core";
import { isJsonString } from "../json.js";
import {
	type ElevatedCapabilityTrust,
	verifyElevatedAccessCapability,
} from "./elevated-capability.js";
import type { BreakGlassService, CrossEnvGrantStore } from "./grants.js";
import type { EnvMembershipService } from "./membership.js";
import { assertMembershipIntegrity } from "./membership.js";
import {
	DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK,
	type EnvNetworkIsolationPolicyPack,
} from "./policy-pack.js";
import {
	classesDiffer,
	type IsolationClass,
	parseIsolationClass,
} from "./types.js";

export type EnvIsolationEvalContext = Readonly<{
	/** Control-plane membership service (optional; when absent, tag-only soft path with integrity fail for critical). */
	membership?: EnvMembershipService;
	crossEnvGrants?: CrossEnvGrantStore;
	breakGlass?: BreakGlassService;
	policyPack?: EnvNetworkIsolationPolicyPack;
	/** Elevated capability JWT if presented. */
	elevatedToken?: string;
	/** Whose elevated capabilities are accepted, and how they are verified. Absent: none is. */
	elevatedTrust?: ElevatedCapabilityTrust;
	/** Cross-env grant id if presented. */
	crossEnvGrantId?: string;
	/** Simulated engine failure → fail closed. */
	engineUnavailable?: boolean;
	now?: string;
	/** When true (default), missing env denies. */
	requireEnv?: boolean;
	/**
	 * When true, client env: tags must match control-plane membership.
	 * Default true for production-class resources.
	 */
	enforceMembershipIntegrity?: boolean;
}>;

export type EnvIsolationVerdict = Readonly<{
	allow: boolean;
	reasons: readonly string[];
	subjectClass: IsolationClass | null;
	resourceClass: IsolationClass | null;
	code?: string;
}>;

/**
 * Evaluate environment isolation for a PolicyRequest.
 * Order: engine down → missing env → membership integrity → same env →
 * cross-env grant / elevated / break-glass → deny.
 */
export async function evaluateEnvIsolation(
	request: PolicyRequest,
	ctx: EnvIsolationEvalContext = {},
): Promise<EnvIsolationVerdict> {
	const pack = ctx.policyPack ?? DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK;
	const requireEnv = ctx.requireEnv !== false;

	if (ctx.engineUnavailable === true || pack.failClosed !== true) {
		if (ctx.engineUnavailable === true) {
			return {
				allow: false,
				reasons: [
					"policy engine / overlay control plane unavailable — fail closed",
				],
				subjectClass: null,
				resourceClass: null,
				code: "engine-unavailable",
			};
		}
	}

	const subjectClass = parseIsolationClass([
		...request.subject.tags,
		...(request.subject.attributes?.env
			? [`env:${request.subject.attributes.env}`]
			: []),
	]);
	const resourceClass = parseIsolationClass([
		...(request.resource.tags ?? []),
		...(request.resource.attributes?.env
			? [`env:${request.resource.attributes.env}`]
			: []),
	]);

	if (requireEnv && (subjectClass === null || resourceClass === null)) {
		return {
			allow: false,
			reasons: [
				subjectClass === null
					? "subject isolation class missing"
					: "resource isolation class missing",
			],
			subjectClass,
			resourceClass,
			code: "env-missing",
		};
	}

	// Membership integrity for isolation-critical resource classes.
	const critical =
		resourceClass === "production" ||
		resourceClass === "staging" ||
		pack.requireControlPlaneMembership;
	if (
		critical &&
		ctx.enforceMembershipIntegrity !== false &&
		ctx.membership &&
		subjectClass
	) {
		await ctx.membership.refresh();
		const mem = ctx.membership.getActive(
			request.subject.identity,
			subjectClass,
			ctx.now,
		);
		const integrity = assertMembershipIntegrity({
			claimedClass: subjectClass,
			membership: mem,
			principalId: request.subject.identity,
		});
		if (!integrity.ok) {
			// Agent principals: same or stricter
			const isAgent =
				request.subject.tags.includes("principal:agent") ||
				request.subject.attributes?.principalKind === "agent" ||
				request.subject.identity.includes("/agent/");
			return {
				allow: false,
				reasons: [
					integrity.reason,
					...(isAgent && pack.agentSameOrStricter
						? ["agent principal cannot ambiently escalate"]
						: []),
				],
				subjectClass,
				resourceClass,
				code: integrity.code,
			};
		}
	}

	if (!classesDiffer(subjectClass, resourceClass)) {
		return {
			allow: true,
			reasons: ["same-isolation-class"],
			subjectClass,
			resourceClass,
			code: "same-env",
		};
	}

	// Cross-env path: require explicit grant / elevated / break-glass.
	const now = ctx.now ?? new Date().toISOString();

	if (
		ctx.crossEnvGrantId &&
		ctx.crossEnvGrants &&
		subjectClass &&
		resourceClass
	) {
		const g = ctx.crossEnvGrants.getActive(ctx.crossEnvGrantId, now);
		if (
			g &&
			g.fromClass === subjectClass &&
			g.toClass === resourceClass &&
			(g.principalIds.length === 0 ||
				g.principalIds.includes(request.subject.identity))
		) {
			return {
				allow: true,
				reasons: [`cross-env-grant:${g.id}`],
				subjectClass,
				resourceClass,
				code: "cross-env-grant",
			};
		}
	}

	if (
		ctx.crossEnvGrants &&
		subjectClass &&
		resourceClass &&
		ctx.crossEnvGrants.allows({
			principalId: request.subject.identity,
			fromClass: subjectClass,
			toClass: resourceClass,
			now,
		})
	) {
		return {
			allow: true,
			reasons: ["cross-env-grant:active"],
			subjectClass,
			resourceClass,
			code: "cross-env-grant",
		};
	}

	if (ctx.elevatedToken && resourceClass) {
		const audience = `${resourceClass}-access`;
		const verified = await verifyElevatedAccessCapability({
			token: ctx.elevatedToken,
			expectedAudience: audience,
			expectedIsolationClass: resourceClass,
			trust: ctx.elevatedTrust,
			now,
		});
		if (verified.ok) {
			return {
				allow: true,
				reasons: [
					`elevated-capability:${verified.capability.id}`,
					"network-membership-not-sufficient-alone",
				],
				subjectClass,
				resourceClass,
				code: "elevated-capability",
			};
		}
	}

	if (ctx.breakGlass && resourceClass) {
		const bg = ctx.breakGlass.allows({
			subject: request.subject.identity,
			isolationClass: resourceClass,
			now,
		});
		if (bg) {
			return {
				allow: true,
				reasons: [`break-glass:${bg.id}`],
				subjectClass,
				resourceClass,
				code: "break-glass",
			};
		}
	}

	// Context may carry elevated token / grant on request.context
	const ctxElevated = isJsonString(request.context?.elevatedToken)
		? request.context.elevatedToken
		: undefined;
	if (ctxElevated && resourceClass && !ctx.elevatedToken) {
		const audience = `${resourceClass}-access`;
		const verified = await verifyElevatedAccessCapability({
			token: ctxElevated,
			expectedAudience: audience,
			expectedIsolationClass: resourceClass,
			trust: ctx.elevatedTrust,
			now,
		});
		if (verified.ok) {
			return {
				allow: true,
				reasons: [`elevated-capability:${verified.capability.id}`],
				subjectClass,
				resourceClass,
				code: "elevated-capability",
			};
		}
	}

	return {
		allow: false,
		reasons: [
			`cross-env access denied (${subjectClass ?? "none"} → ${resourceClass ?? "none"})`,
			"elevated capability or cross-env grant required",
		],
		subjectClass,
		resourceClass,
		code: "cross-env-denied",
	};
}
