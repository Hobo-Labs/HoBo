/**
 * The in-process policy evaluator.
 *
 * This runs when OPA is unavailable, which means it is the thing actually
 * deciding access on the local and offline paths. Every branch here is a
 * security decision, and two properties matter more than the individual rules:
 *
 * **Deny is the default, everywhere.** An unparseable document, an empty rule
 * list, an unmatched request, a missing `default` — all of them deny. A policy
 * engine that fails open is worse than no policy engine, because it reports
 * that a decision was made.
 *
 * **`false` is not the same as absent.** Every `when` predicate is tri-state:
 * `sameTenant: true` requires it, `sameTenant: false` requires the *opposite*,
 * and omitting it means "don't care". Collapsing `false` into absent would
 * silently widen every rule that uses it — and the negative forms are exactly
 * how cross-tenant and cross-env rules get written.
 *
 * Cross-env access is denied by default (the Environment Network Isolation
 * pack), so `sameEnv` is tested against untagged subjects too: an environment
 * that cannot be determined must not count as matching.
 */
import type { PolicyRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	ENV_NETWORK_ISOLATION_REGO_DOCUMENT,
	evaluateRegoLite,
	HOBO_DEFAULT_POLICY_DOCUMENT,
	parseRegoLiteDocument,
	type RegoLiteDocument,
} from "../../src/policy/rego-lite.js";

function request(
	overrides: {
		subjectTags?: string[];
		resourceTags?: string[];
		subjectTenant?: string;
		resourceTenant?: string;
		action?: string;
		kind?: string;
		attributes?: Record<string, string>;
	} = {},
): PolicyRequest {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		subject: {
			id: "s1",
			// SAFETY: assertion required at this I/O or test boundary.
			tenantId: (overrides.subjectTenant ?? "t1") as never,
			tags: overrides.subjectTags ?? [],
		},
		action: overrides.action ?? "junction.join",
		resource: {
			id: "r1",
			kind: overrides.kind ?? "junction",
			// SAFETY: assertion required at this I/O or test boundary.
			tenantId: (overrides.resourceTenant ?? "t1") as never,
			tags: overrides.resourceTags ?? [],
			...(overrides.attributes
				? { attributes: overrides.attributes }
				: undefined),
		},
	} as PolicyRequest;
}

const doc = (rules: RegoLiteDocument["rules"], def?: "allow" | "deny") =>
	// SAFETY: assertion required at this I/O or test boundary.
	({ rules, ...(def ? { default: def } : undefined) }) as RegoLiteDocument;

const effectOf = (d: RegoLiteDocument, r: PolicyRequest) =>
	evaluateRegoLite(d, r).effect;

describe("parseRegoLiteDocument", () => {
	it("parses a minimal document", () => {
		const parsed = parseRegoLiteDocument({ rules: [{ effect: "allow" }] });
		expect(parsed.rules).toHaveLength(1);
	});

	it("rejects a non-object", () => {
		expect(() => parseRegoLiteDocument("nope")).toThrow(TypeError);
	});

	it("rejects null", () => {
		// isJsonObject(null), so this needs its own guard and its own test.
		expect(() => parseRegoLiteDocument(null)).toThrow(TypeError);
	});

	it("rejects a document with no rules array", () => {
		expect(() => parseRegoLiteDocument({})).toThrow(/rules must be an array/u);
	});

	it("rejects a non-object rule, naming its index", () => {
		expect(() => parseRegoLiteDocument({ rules: [null] })).toThrow(
			/rules\[0\]/u,
		);
	});

	it("rejects an unknown effect rather than defaulting it", () => {
		// Defaulting an unrecognised effect to either value would be a policy
		// decision made by a typo.
		expect(() =>
			parseRegoLiteDocument({ rules: [{ effect: "maybe" }] }),
		).toThrow(/effect must be allow\|deny/u);
	});

	it("rejects a missing effect", () => {
		expect(() => parseRegoLiteDocument({ rules: [{}] })).toThrow(/effect/u);
	});

	it("keeps only string actions", () => {
		const parsed = parseRegoLiteDocument({
			rules: [{ effect: "allow", actions: ["a", 7, null, "b"] }],
		});
		expect(parsed.rules[0]?.actions).toEqual(["a", "b"]);
	});

	it("omits actions entirely when not an array", () => {
		const parsed = parseRegoLiteDocument({
			rules: [{ effect: "allow", actions: "a" }],
		});
		expect(parsed.rules[0]).not.toHaveProperty("actions");
	});

	it("keeps a when clause", () => {
		const parsed = parseRegoLiteDocument({
			rules: [{ effect: "allow", when: { sameTenant: true } }],
		});
		expect(parsed.rules[0]?.when).toEqual({ sameTenant: true });
	});

	it("drops a non-object when clause", () => {
		const parsed = parseRegoLiteDocument({
			rules: [{ effect: "allow", when: "always" }],
		});
		expect(parsed.rules[0]).not.toHaveProperty("when");
	});

	it("keeps a string reason and drops a non-string one", () => {
		expect(
			parseRegoLiteDocument({ rules: [{ effect: "allow", reason: "why" }] })
				.rules[0]?.reason,
		).toBe("why");
		expect(
			parseRegoLiteDocument({ rules: [{ effect: "allow", reason: 7 }] })
				.rules[0],
		).not.toHaveProperty("reason");
	});

	it("keeps a valid default and drops an invalid one", () => {
		expect(parseRegoLiteDocument({ rules: [], default: "allow" }).default).toBe(
			"allow",
		);
		expect(
			parseRegoLiteDocument({ rules: [], default: "sometimes" }),
		).not.toHaveProperty("default");
	});

	it("accepts an empty rule list", () => {
		expect(parseRegoLiteDocument({ rules: [] }).rules).toEqual([]);
	});
});

describe("defaults", () => {
	it("denies when no rule matches and no default is set", () => {
		// The single most important assertion in this file.
		expect(effectOf(doc([]), request())).toBe("deny");
	});

	it("allows when the document says so explicitly", () => {
		expect(effectOf(doc([], "allow"), request())).toBe("allow");
	});

	it("says which default it applied", () => {
		expect(evaluateRegoLite(doc([]), request()).reasons).toContain(
			"rego-lite default deny",
		);
	});

	it("reports the default-allow reason distinctly", () => {
		expect(evaluateRegoLite(doc([], "allow"), request()).reasons).toContain(
			"rego-lite default allow",
		);
	});
});

describe("action matching", () => {
	it("matches an exact action", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", actions: ["junction.join"] }]),
				request(),
			),
		).toBe("allow");
	});

	it("does not match a different action", () => {
		expect(
			effectOf(doc([{ effect: "allow", actions: ["dns.write"] }]), request()),
		).toBe("deny");
	});

	it("matches every action with a wildcard", () => {
		expect(
			effectOf(doc([{ effect: "allow", actions: ["*"] }]), request()),
		).toBe("allow");
	});

	it("treats an omitted action list as matching everything", () => {
		expect(effectOf(doc([{ effect: "allow" }]), request())).toBe("allow");
	});

	it("treats an empty action list as matching everything", () => {
		expect(effectOf(doc([{ effect: "allow", actions: [] }]), request())).toBe(
			"allow",
		);
	});

	it("also reads actions from inside the when clause", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { actions: ["junction.join"] } }]),
				request(),
			),
		).toBe("allow");
	});

	it("prefers the rule-level action list over the when-level one", () => {
		expect(
			effectOf(
				doc([
					{
						effect: "allow",
						actions: ["dns.write"],
						when: { actions: ["junction.join"] },
					},
				]),
				request(),
			),
		).toBe("deny");
	});
});

describe("rule ordering", () => {
	it("takes the first matching rule", () => {
		expect(
			effectOf(doc([{ effect: "deny" }, { effect: "allow" }]), request()),
		).toBe("deny");
	});

	it("skips a non-matching rule to reach a later one", () => {
		expect(
			effectOf(
				doc([{ effect: "deny", actions: ["dns.write"] }, { effect: "allow" }]),
				request(),
			),
		).toBe("allow");
	});

	it("carries the matched rule's reason", () => {
		expect(
			evaluateRegoLite(
				doc([{ effect: "allow", reason: "because I said so" }]),
				request(),
			).reasons,
		).toContain("because I said so");
	});

	it("synthesizes a reason when the rule has none", () => {
		expect(
			evaluateRegoLite(doc([{ effect: "deny" }]), request()).reasons,
		).toContain("rego-lite rule deny");
	});
});

describe("sameTenant is tri-state", () => {
	it("requires a tenant match when true", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameTenant: true } }]),
				request({ resourceTenant: "t2" }),
			),
		).toBe("deny");
	});

	it("matches when the tenants agree", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameTenant: true } }]),
				request(),
			),
		).toBe("allow");
	});

	it("requires the tenants to differ when false", () => {
		// The negative form is how a cross-tenant rule gets written; collapsing
		// it into "absent" would silently widen the rule to everything.
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameTenant: false } }]),
				request(),
			),
		).toBe("deny");
	});

	it("matches a cross-tenant request when false", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameTenant: false } }]),
				request({ resourceTenant: "t2" }),
			),
		).toBe("allow");
	});

	it("ignores tenancy when the predicate is absent", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceKinds: ["junction"] } }]),
				request({ resourceTenant: "t2" }),
			),
		).toBe("allow");
	});
});

describe("sameEnv is tri-state", () => {
	it("matches when both carry the same isolation class", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameEnv: true } }]),
				request({ subjectTags: ["env:prod"], resourceTags: ["env:prod"] }),
			),
		).toBe("allow");
	});

	it("does not match across environments", () => {
		// Cross-env is the thing the isolation pack exists to prevent.
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameEnv: true } }]),
				request({ subjectTags: ["env:prod"], resourceTags: ["env:dev"] }),
			),
		).toBe("deny");
	});

	it("does not treat an untagged subject as matching", () => {
		// An environment that cannot be determined must not count as the same
		// one; that would make the check pass exactly where it is least safe.
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameEnv: true } }]),
				request({ resourceTags: ["env:prod"] }),
			),
		).toBe("deny");
	});

	it("does not treat an untagged resource as matching", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameEnv: true } }]),
				request({ subjectTags: ["env:prod"] }),
			),
		).toBe("deny");
	});

	it("requires different environments when false", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { sameEnv: false } }]),
				request({ subjectTags: ["env:prod"], resourceTags: ["env:prod"] }),
			),
		).toBe("deny");
	});
});

describe("resourceShared", () => {
	it("matches a resource tagged shared", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceShared: true } }]),
				request({ resourceTags: ["shared:true"] }),
			),
		).toBe("allow");
	});

	it("also reads sharedness from an attribute", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceShared: true } }]),
				request({ attributes: { shared: "true" } }),
			),
		).toBe("allow");
	});

	it("does not match an unshared resource", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceShared: true } }]),
				request(),
			),
		).toBe("deny");
	});

	it("requires an unshared resource when false", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceShared: false } }]),
				request({ resourceTags: ["shared:true"] }),
			),
		).toBe("deny");
	});

	it('does not treat a non-"true" attribute as shared', () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceShared: true } }]),
				request({ attributes: { shared: "yes" } }),
			),
		).toBe("deny");
	});
});

describe("resourceKinds", () => {
	it("matches a listed kind", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceKinds: ["junction"] } }]),
				request(),
			),
		).toBe("allow");
	});

	it("does not match an unlisted kind", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceKinds: ["dns-endpoint"] } }]),
				request(),
			),
		).toBe("deny");
	});

	it("ignores an empty kind list rather than matching nothing", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { resourceKinds: [] } }]),
				request(),
			),
		).toBe("allow");
	});
});

describe("subject tags", () => {
	it("matches when any listed tag is present", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { subjectTagsAny: ["role:admin"] } }]),
				request({ subjectTags: ["role:admin", "team:x"] }),
			),
		).toBe("allow");
	});

	it("does not match when none is present", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { subjectTagsAny: ["role:admin"] } }]),
				request({ subjectTags: ["team:x"] }),
			),
		).toBe("deny");
	});

	it("requires every tag for subjectTagsAll", () => {
		expect(
			effectOf(
				doc([
					{ effect: "allow", when: { subjectTagsAll: ["role:admin", "mfa"] } },
				]),
				request({ subjectTags: ["role:admin"] }),
			),
		).toBe("deny");
	});

	it("matches when every required tag is present", () => {
		expect(
			effectOf(
				doc([
					{ effect: "allow", when: { subjectTagsAll: ["role:admin", "mfa"] } },
				]),
				request({ subjectTags: ["mfa", "role:admin", "extra"] }),
			),
		).toBe("allow");
	});

	it("ignores an empty tag list", () => {
		expect(
			effectOf(
				doc([{ effect: "allow", when: { subjectTagsAny: [] } }]),
				request(),
			),
		).toBe("allow");
	});

	it("requires every predicate in a when clause, not just one", () => {
		expect(
			effectOf(
				doc([
					{
						effect: "allow",
						when: { sameTenant: true, subjectTagsAny: ["role:admin"] },
					},
				]),
				request({ subjectTags: ["team:x"] }),
			),
		).toBe("deny");
	});
});

describe("the shipped documents", () => {
	it("denies by default", () => {
		expect(HOBO_DEFAULT_POLICY_DOCUMENT.default).toBe("deny");
		expect(ENV_NETWORK_ISOLATION_REGO_DOCUMENT.default).toBe("deny");
	});

	it("allows an admin within one environment", () => {
		expect(
			effectOf(
				HOBO_DEFAULT_POLICY_DOCUMENT,
				request({
					subjectTags: ["role:admin", "env:prod"],
					resourceTags: ["env:prod"],
				}),
			),
		).toBe("allow");
	});

	it("denies an admin reaching across environments", () => {
		// The pack's whole point: role does not cross an environment boundary.
		expect(
			effectOf(
				HOBO_DEFAULT_POLICY_DOCUMENT,
				request({
					subjectTags: ["role:admin", "env:prod"],
					resourceTags: ["env:dev"],
				}),
			),
		).toBe("deny");
	});

	it("allows same-tenant traffic inside one environment", () => {
		expect(
			effectOf(
				HOBO_DEFAULT_POLICY_DOCUMENT,
				request({ subjectTags: ["env:prod"], resourceTags: ["env:prod"] }),
			),
		).toBe("allow");
	});

	it("denies same-tenant traffic when no environment is declared", () => {
		expect(effectOf(HOBO_DEFAULT_POLICY_DOCUMENT, request())).toBe("deny");
	});

	it("allows a shared resource inside one environment", () => {
		expect(
			effectOf(
				HOBO_DEFAULT_POLICY_DOCUMENT,
				request({
					subjectTags: ["env:prod"],
					resourceTags: ["env:prod", "shared:true"],
					resourceTenant: "t2",
				}),
			),
		).toBe("allow");
	});

	it("denies cross-tenant unshared traffic", () => {
		expect(
			effectOf(
				HOBO_DEFAULT_POLICY_DOCUMENT,
				request({
					subjectTags: ["env:prod"],
					resourceTags: ["env:prod"],
					resourceTenant: "t2",
				}),
			),
		).toBe("deny");
	});

	it("denies everything cross-env under the isolation pack", () => {
		expect(
			effectOf(
				ENV_NETWORK_ISOLATION_REGO_DOCUMENT,
				request({ subjectTags: ["env:prod"], resourceTags: ["env:dev"] }),
			),
		).toBe("deny");
	});
});

describe("the engine id", () => {
	it("defaults to the rego-lite engine", () => {
		expect(evaluateRegoLite(doc([]), request()).engineId).toBe(
			"hobo.policy.opa-rego/v1",
		);
	});

	it("can be overridden, so a wrapping engine reports itself", () => {
		expect(
			evaluateRegoLite(doc([]), request(), "hobo.policy.opa-http/v1").engineId,
		).toBe("hobo.policy.opa-http/v1");
	});
});
