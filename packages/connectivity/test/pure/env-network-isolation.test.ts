/**
 * Environment Network Isolation conformance suite (offline).
 * Proves walls between isolation classes + positive controls.
 */

import { createMeteringBus, parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	assertComposedIsolation,
	assertLocalNamedEndpointBackend,
	BreakGlassService,
	CrossEnvGrantStore,
	createEnvNetworkIsolationRegistry,
	createTagAclPolicyEngine,
	createTailscaleOverlay,
	createTenantIsolationRegistry,
	DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK,
	ENV_NETWORK_ISOLATION_POLICY_PACK_ID,
	EnvMembershipService,
	evaluateEnvIsolation,
	evaluateOverlayJoin,
	hoboDevOverlayJoinAllowed,
	mintElevatedAccessCapability,
	parseEnvNetworkIsolationPolicyPack,
	tenantFromSlug,
	verifyElevatedAccessCapability,
} from "../../src/index.js";
import type { JsonObject } from "../../src/json.js";
import { createInMemoryMeteringSink } from "../../src/metering/sinks.js";
import {
	ENV_NETWORK_ISOLATION_REGO_DOCUMENT,
	evaluateRegoLite,
} from "../../src/policy/rego-lite.js";
import { createTestElevatedIssuer } from "../support/elevated-issuer.js";

const tenant = parseTenantId("acme");

function req(
	subjectEnv: string | null,
	resourceEnv: string | null,
	extra?: {
		subjectTags?: string[];
		resourceTags?: string[];
		identity?: string;
		context?: JsonObject;
		resourceTenant?: ReturnType<typeof parseTenantId>;
	},
) {
	return {
		subject: {
			identity: extra?.identity ?? "user:alice",
			tenantId: tenant,
			tags: [
				...(subjectEnv ? [`env:${subjectEnv}`] : []),
				...(extra?.subjectTags ?? ["role:developer"]),
			],
		},
		action: "connect",
		resource: {
			kind: "endpoint",
			id: "api",
			tenantId: extra?.resourceTenant ?? tenant,
			tags: [
				...(resourceEnv ? [`env:${resourceEnv}`] : []),
				...(extra?.resourceTags ?? []),
			],
		},
		...(extra?.context ? { context: extra.context } : undefined),
	};
}

describe("Environment Network Isolation conformance", () => {
	it("denies cross-env development → production", async () => {
		const engine = createTagAclPolicyEngine();
		const decision = await engine.evaluate(req("development", "production"));
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.some((r) => r.includes("cross-env"))).toBe(true);
	});

	it("allows same-env under least privilege (positive control)", async () => {
		const engine = createTagAclPolicyEngine();
		const decision = await engine.evaluate(req("development", "development"));
		expect(decision.effect).toBe("allow");
	});

	it("denies missing env tags (fail closed)", async () => {
		const engine = createTagAclPolicyEngine();
		const decision = await engine.evaluate(req(null, "production"));
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toMatch(/missing/i);
	});

	it("valid elevated capability allows production; expired/wrong audience deny", async () => {
		const membership = new EnvMembershipService({ tenant: "acme" });
		membership.assign({
			principalId: "user:alice",
			isolationClass: "development",
			assignedBy: "cp-admin",
		});
		const issuer = createTestElevatedIssuer();
		const elevatedTrust = { issuer: issuer.issuerUrl, verify: issuer.verify };
		const { token, capability } = await mintElevatedAccessCapability({
			subject: "user:alice",
			isolationClass: "production",
			issuedBy: "cp-admin",
			ttlSeconds: 600,
			priorAuthnClass: "development",
			evidence: { kind: "lower-env-authn", ref: "authn-1" },
			issuer,
		});

		const engine = createTagAclPolicyEngine({
			envIsolation: {
				membership,
				elevatedToken: token,
				elevatedTrust,
				enforceMembershipIntegrity: true,
			},
		});
		// Subject still development-tagged; elevated opens production resource.
		const allow = await engine.evaluate(req("development", "production"));
		expect(allow.effect).toBe("allow");
		expect(capability.audience).toBe("production-access");

		const wrong = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "staging-access",
			expectedIsolationClass: "staging",
			trust: elevatedTrust,
		});
		expect(wrong.ok).toBe(false);

		const expired = await verifyElevatedAccessCapability({
			token,
			expectedAudience: "production-access",
			expectedIsolationClass: "production",
			trust: elevatedTrust,
			now: new Date(Date.now() + 3600_000).toISOString(),
		});
		expect(expired.ok).toBe(false);
	});

	it("break-glass dual-approved allows within TTL; expired denies", async () => {
		const bg = new BreakGlassService({ tenant: "acme" });
		const requested = bg.request({
			subject: "user:oncall",
			isolationClass: "production",
			reason: "sev1",
			requester: "user:oncall",
		});
		const granted = bg.approve({
			grantId: requested.id,
			approver: "user:security",
			ttlSeconds: 300,
		});
		expect(granted.status).toBe("granted");

		const engine = createTagAclPolicyEngine({
			envIsolation: {
				breakGlass: bg,
				// skip membership integrity for this case
				enforceMembershipIntegrity: false,
			},
		});
		const allow = await engine.evaluate(
			req("development", "production", { identity: "user:oncall" }),
		);
		expect(allow.effect).toBe("allow");

		const expired = bg.getActive(
			granted.id,
			new Date(Date.now() + 400_000).toISOString(),
		);
		expect(expired).toBeNull();
	});

	it("local-dev air-gap: local backend must not be remote/prod", () => {
		expect(
			assertLocalNamedEndpointBackend({
				mode: "local",
				backendUrl: "http://127.0.0.1:3000",
				resourceEnv: "local-dev",
			}).ok,
		).toBe(true);
		expect(
			assertLocalNamedEndpointBackend({
				mode: "local",
				backendUrl: "https://api.prod.amazonaws.com",
				resourceEnv: "local-dev",
			}).ok,
		).toBe(false);
		expect(hoboDevOverlayJoinAllowed()).toBe(false);
		expect(
			evaluateOverlayJoin({
				callerClass: "local-dev",
				targetClass: "production",
			}).allowed,
		).toBe(false);
	});

	it("junction env scope: cross-env federation refused", async () => {
		// Pure federation check via evaluateEnvIsolation
		const verdict = await evaluateEnvIsolation(
			req("development", "production", {
				subjectTags: ["role:junction"],
				resourceTags: [],
			}),
		);
		expect(verdict.allow).toBe(false);
	});

	it("tenant × env composition: harder axis wins", () => {
		const tenants = createTenantIsolationRegistry({
			shared: createTailscaleOverlay(),
			forTenant: () => createTailscaleOverlay(),
		});
		tenants.registerTenant(tenantFromSlug("hard-a", "hard-overlay"));
		tenants.registerTenant(tenantFromSlug("hard-b", "hard-overlay"));
		const envs = createEnvNetworkIsolationRegistry({
			shared: createTailscaleOverlay(),
			forClass: () => createTailscaleOverlay(),
		});
		envs.registerClass("development", { tier: "soft" });
		envs.registerClass("production", { tier: "hard-overlay" });

		const composed = assertComposedIsolation({
			tenants,
			envs,
			tenantA: "hard-a",
			tenantB: "hard-b",
			envA: "development",
			envB: "production",
		});
		expect(composed.isolated).toBe(true);
		expect(
			composed.axis === "tenant" ||
				composed.axis === "both" ||
				composed.axis === "environment",
		).toBe(true);
	});

	it("agent principal cannot ambiently escalate without membership", async () => {
		const membership = new EnvMembershipService({ tenant: "acme" });
		// no membership assigned for agent
		const engine = createTagAclPolicyEngine({
			envIsolation: {
				membership,
				enforceMembershipIntegrity: true,
			},
		});
		const decision = await engine.evaluate(
			req("development", "production", {
				identity: "spiffe://yard/agent/bot",
				subjectTags: ["principal:agent", "role:agent"],
			}),
		);
		expect(decision.effect).toBe("deny");
	});

	it("policy engine unavailable → fail closed", async () => {
		const engine = createTagAclPolicyEngine({
			envIsolation: { engineUnavailable: true },
		});
		const decision = await engine.evaluate(req("development", "development"));
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toMatch(/fail closed/i);
	});

	it("preview/ephemeral membership auto-expires", () => {
		const membership = new EnvMembershipService({ tenant: "acme" });
		const rec = membership.assign({
			principalId: "user:ci",
			isolationClass: "ephemeral",
			assignedBy: "cp-admin",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		expect(rec.expiresAt).toBeTruthy();
		expect(
			membership.getActive("user:ci", "ephemeral", new Date().toISOString()),
		).toBeNull();
	});

	it("PAM gateway resource is env-scoped (cross-env reach denied)", async () => {
		const engine = createTagAclPolicyEngine();
		const decision = await engine.evaluate({
			subject: {
				identity: "user:alice",
				tenantId: tenant,
				tags: ["env:development", "role:developer"],
			},
			action: "pam.session",
			resource: {
				kind: "pam-gateway",
				id: "station-prod-pam",
				tenantId: tenant,
				tags: ["env:production", "capability:privileged-access-gateway"],
			},
		});
		expect(decision.effect).toBe("deny");
	});

	it("client-supplied env:production without membership does not authorize", async () => {
		const membership = new EnvMembershipService({ tenant: "acme" });
		const engine = createTagAclPolicyEngine({
			envIsolation: {
				membership,
				enforceMembershipIntegrity: true,
			},
		});
		// Subject claims production tag but no control-plane membership
		const decision = await engine.evaluate(req("production", "production"));
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toMatch(/membership/i);
	});

	it("positive control: membership + same-env allow", async () => {
		const membership = new EnvMembershipService({ tenant: "acme" });
		membership.assign({
			principalId: "user:alice",
			isolationClass: "development",
			assignedBy: "cp-admin",
		});
		const engine = createTagAclPolicyEngine({
			envIsolation: {
				membership,
				enforceMembershipIntegrity: true,
			},
		});
		const decision = await engine.evaluate(req("development", "development"));
		expect(decision.effect).toBe("allow");
	});

	it("cross-env grant allows time-bound path", async () => {
		const grants = new CrossEnvGrantStore({ tenant: "acme" });
		const g = grants.issue({
			fromClass: "development",
			toClass: "staging",
			principalIds: ["user:alice"],
			reason: "debug",
			issuedBy: "cp-admin",
			ttlSeconds: 600,
		});
		const engine = createTagAclPolicyEngine({
			envIsolation: {
				crossEnvGrants: grants,
				crossEnvGrantId: g.id,
				enforceMembershipIntegrity: false,
			},
		});
		const decision = await engine.evaluate(req("development", "staging"));
		expect(decision.effect).toBe("allow");
	});

	it("policy pack is loadable and refuse silent widening", () => {
		const pack = parseEnvNetworkIsolationPolicyPack(
			DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK,
		);
		expect(pack.id).toBe(ENV_NETWORK_ISOLATION_POLICY_PACK_ID);
		expect(pack.failClosed).toBe(true);
		expect(pack.defaultDenyCrossEnv).toBe(true);
		// `parseEnvNetworkIsolationPolicyPack` has three refusal branches and a
		// bare `.toThrow()` could not tell them apart: a pack that lost its
		// `failClosed` guard entirely would still have gone green here, refused
		// one line earlier on the id. Each row names the branch it exercises.
		expect(() =>
			parseEnvNetworkIsolationPolicyPack({
				id: ENV_NETWORK_ISOLATION_POLICY_PACK_ID,
				failClosed: false,
				defaultDenyCrossEnv: true,
			}),
		).toThrow(
			new TypeError(
				"env isolation pack must keep failClosed and defaultDenyCrossEnv true",
			),
		);
		expect(() =>
			parseEnvNetworkIsolationPolicyPack({
				id: ENV_NETWORK_ISOLATION_POLICY_PACK_ID,
				failClosed: true,
				defaultDenyCrossEnv: false,
			}),
		).toThrow(
			new TypeError(
				"env isolation pack must keep failClosed and defaultDenyCrossEnv true",
			),
		);
		expect(() =>
			parseEnvNetworkIsolationPolicyPack({
				id: "hobo.policy.pack.someone-elses/v1",
				failClosed: true,
				defaultDenyCrossEnv: true,
			}),
		).toThrow(
			new TypeError(
				`policy pack id must be ${ENV_NETWORK_ISOLATION_POLICY_PACK_ID}`,
			),
		);
		expect(() => parseEnvNetworkIsolationPolicyPack(null)).toThrow(
			new TypeError("env network isolation policy pack must be an object"),
		);
	});

	it("rego-lite env isolation document denies cross-env", () => {
		const allow = evaluateRegoLite(
			ENV_NETWORK_ISOLATION_REGO_DOCUMENT,
			req("development", "development"),
		);
		expect(allow.effect).toBe("allow");
		const deny = evaluateRegoLite(
			ENV_NETWORK_ISOLATION_REGO_DOCUMENT,
			req("development", "production"),
		);
		expect(deny.effect).toBe("deny");
	});

	it("meters env isolation decisions", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const engine = createTagAclPolicyEngine({ metering: bus });
		await engine.evaluate(req("development", "production"));
		expect(
			sink.events.some(
				(e) =>
					e.eventType === "policy.evaluate" &&
					e.metadata?.axis === "environment",
			),
		).toBe(true);
	});

	it("production membership requires dual control", () => {
		const membership = new EnvMembershipService({ tenant: "acme" });
		expect(() =>
			membership.assign({
				principalId: "user:alice",
				isolationClass: "production",
				assignedBy: "cp-admin",
			}),
		).toThrow(/dual control/i);
		const ok = membership.assign({
			principalId: "user:alice",
			isolationClass: "production",
			assignedBy: "cp-admin",
			secondApprover: "security-officer",
		});
		expect(ok.dualControlRequired).toBe(true);
	});
});
