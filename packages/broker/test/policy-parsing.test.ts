import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
	BrokerParseError,
	effectivePlacementPolicy,
	normalizeDeliveryPolicy,
	parseBillingPolicy,
	parseBrokerPolicySet,
	parseBrokerRequest,
	parseDeliveryPolicy,
	parsePlacementPolicy,
	parseResourceRequirement,
	parseTopologyScope,
} from "../src/policies.js";
import { BROKER_SCHEMA_VERSION, type TopologyScope } from "../src/types.js";

function codeOf(run: () => void): string {
	try {
		run();
	} catch (error) {
		if (error instanceof BrokerParseError) return error.code;
		return `not-a-parse-error: ${String(error)}`;
	}
	return "no-refusal";
}

const placement = (over: JsonObject = {}) => ({
	id: "p1",
	scopeKind: "bindle",
	objective: "min-cost",
	...over,
});

describe("placement policies", () => {
	it("refuses anything that is not an object", () => {
		expect(codeOf(() => parsePlacementPolicy([]))).toBe(
			"invalid-placement-policy",
		);
		expect(codeOf(() => parsePlacementPolicy(null))).toBe(
			"invalid-placement-policy",
		);
		expect(codeOf(() => parsePlacementPolicy("p1"))).toBe(
			"invalid-placement-policy",
		);
	});

	it("refuses an empty id as firmly as a missing one", () => {
		expect(codeOf(() => parsePlacementPolicy(placement({ id: "" })))).toBe(
			"invalid-placement-policy",
		);
	});

	it("accepts the snake_case spelling of every aliased field", () => {
		const parsed = parsePlacementPolicy({
			id: "p1",
			scope_kind: "camp",
			objective: "pinned",
			pinned_provider_id: "aws",
			require_explicit_camps: true,
		});
		expect(parsed.scopeKind).toBe("camp");
		expect(parsed.pinnedProviderId).toBe("aws");
		expect(parsed.requireExplicitCamps).toBe(true);
	});

	it("refuses a scope kind outside the known set", () => {
		expect(
			codeOf(() => parsePlacementPolicy(placement({ scopeKind: "tenant" }))),
		).toBe("invalid-scope-kind");
	});

	it("refuses an objective outside the known set", () => {
		expect(
			codeOf(() => parsePlacementPolicy(placement({ objective: "fastest" }))),
		).toBe("invalid-objective");
	});

	it("refuses the pinned objective with no provider named", () => {
		expect(
			codeOf(() => parsePlacementPolicy(placement({ objective: "pinned" }))),
		).toBe("pinned-provider-required");
	});

	it("treats an empty pinned provider as absent", () => {
		expect(
			codeOf(() =>
				parsePlacementPolicy(
					placement({ objective: "pinned", pinnedProviderId: "" }),
				),
			),
		).toBe("pinned-provider-required");
	});

	it("locks down explicit camps only on a literal true", () => {
		const on = parsePlacementPolicy(placement({ requireExplicitCamps: true }));
		expect(on.requireExplicitCamps).toBe(true);
		for (const value of ["true", 1, {}, []]) {
			expect(
				parsePlacementPolicy(placement({ requireExplicitCamps: value }))
					.requireExplicitCamps,
			).toBe(false);
		}
	});
});

describe("billing policies", () => {
	it("defaults every amount to zero rather than refusing", () => {
		const parsed = parseBillingPolicy({ quota: "standard" });
		expect(parsed.quotaUsed).toBe(0);
		expect(parsed.quotaLimit).toBe(0);
		expect(parsed.budgetUsd).toBe(0);
		expect(parsed.spendCapUsd).toBe(0);
	});

	it("requires a quota name", () => {
		expect(codeOf(() => parseBillingPolicy({}))).toBe("invalid-billing-policy");
	});

	it("refuses a negative amount", () => {
		expect(
			codeOf(() => parseBillingPolicy({ quota: "standard", quotaUsed: -1 })),
		).toBe("invalid-billing-policy");
	});

	it("refuses NaN, which compares false against every limit", () => {
		expect(
			codeOf(() => parseBillingPolicy({ quota: "standard", quotaUsed: NaN })),
		).toBe("invalid-billing-policy");
	});

	it("refuses consumed quota above the limit", () => {
		expect(
			codeOf(() =>
				parseBillingPolicy({
					quota: "standard",
					quota_used: 10,
					quota_limit: 5,
				}),
			),
		).toBe("quota-overflow");
	});

	it("allows consumption exactly at the limit", () => {
		expect(
			parseBillingPolicy({
				quota: "standard",
				quotaUsed: 5,
				quotaLimit: 5,
			}).quotaUsed,
		).toBe(5);
	});
});

describe("delivery policies (neutral, D14)", () => {
	it("normalizes a legacy in-code literal exactly as the wire parser maps it", () => {
		expect(
			normalizeDeliveryPolicy({
				engine: "argo",
				syncMode: "auto",
				prune: true,
				gitopsRepo: "https://git.example/r",
				destinationNamespace: "never-read",
			}),
		).toEqual(
			parseDeliveryPolicy({
				engine: "argo",
				syncMode: "auto",
				prune: true,
				gitopsRepo: "https://git.example/r",
			}),
		);
		const neutral = parseDeliveryPolicy({ reconcilerMode: "agent" });
		expect(normalizeDeliveryPolicy(neutral)).toBe(neutral);
	});

	it("refuses an unknown reconciler mode and an unknown legacy engine", () => {
		expect(codeOf(() => parseDeliveryPolicy({ reconcilerMode: "push" }))).toBe(
			"invalid-reconciler-mode",
		);
		expect(codeOf(() => parseDeliveryPolicy({ engine: "flux" }))).toBe(
			"invalid-delivery-engine",
		);
	});

	it("defaults the sync mode to manual", () => {
		expect(parseDeliveryPolicy({ reconcilerMode: "conductor" }).syncMode).toBe(
			"manual",
		);
		expect(parseDeliveryPolicy({ engine: "in-proc" }).syncMode).toBe("manual");
	});

	it("refuses an unknown sync mode", () => {
		expect(
			codeOf(() =>
				parseDeliveryPolicy({
					reconcilerMode: "conductor",
					sync_mode: "hourly",
				}),
			),
		).toBe("invalid-sync-mode");
	});

	it("requires a publisher target in publisher mode, and only there", () => {
		expect(
			codeOf(() => parseDeliveryPolicy({ reconcilerMode: "publisher" })),
		).toBe("publisher-required");
		expect(
			codeOf(() =>
				parseDeliveryPolicy({
					reconcilerMode: "agent",
					publisher: { target: "flux" },
				}),
			),
		).toBe("publisher-mode-mismatch");
	});

	it("parses a neutral publisher policy in either spelling", () => {
		const parsed = parseDeliveryPolicy({
			reconciler_mode: "publisher",
			publisher: { target: "flux", repository: "https://git.example/r" },
			sync_mode: "auto",
			prune: true,
		});
		expect(parsed).toMatchObject({
			reconcilerMode: "publisher",
			publisher: { target: "flux", repository: "https://git.example/r" },
			syncMode: "auto",
			prune: true,
		});
	});

	it("maps the legacy argo engine to the argo-cd publisher; destination_namespace is never read", () => {
		const parsed = parseDeliveryPolicy({
			engine: "argo",
			gitops_repo: "git://repo",
			destination_namespace: "apps",
			sync_mode: "auto",
			prune: true,
		});
		expect(parsed.reconcilerMode).toBe("publisher");
		expect(parsed.publisher).toEqual({
			target: "argo-cd",
			repository: "git://repo",
		});
		expect(JSON.stringify(parsed)).not.toContain("apps");
		expect(parsed.syncMode).toBe("auto");
		expect(parsed.prune).toBe(true);
		expect(parseDeliveryPolicy({ engine: "argo" }).publisher).toEqual({
			target: "argo-cd",
		});
	});

	it("maps the legacy in-proc engine to the in-process conductor", () => {
		const parsed = parseDeliveryPolicy({ engine: "in-proc" });
		expect(parsed.reconcilerMode).toBe("conductor");
		expect(parsed.publisher).toBeUndefined();
		expect(parsed.prune).toBe(false);
	});

	it("prefers reconcilerMode when both vocabularies are present (engine is never read)", () => {
		const parsed = parseDeliveryPolicy({
			engine: "argo",
			reconcilerMode: "agent",
		});
		expect(parsed.reconcilerMode).toBe("agent");
		expect(parsed.publisher).toBeUndefined();
	});
});

describe("policy sets", () => {
	const set = (over: JsonObject = {}) => ({
		schemaVersion: BROKER_SCHEMA_VERSION,
		brokerId: "b1",
		billing: { quota: "standard" },
		...over,
	});

	it("refuses a policy set that omits billing, naming the missing block", () => {
		expect(() =>
			parseBrokerPolicySet({
				schemaVersion: BROKER_SCHEMA_VERSION,
				brokerId: "b1",
			}),
		).toThrow(
			expect.objectContaining({
				code: "invalid-policy-set",
				message: expect.stringMatching(/billing is required/u),
			}),
		);
	});

	it("refuses a schema version it does not implement", () => {
		expect(
			codeOf(() => parseBrokerPolicySet(set({ schemaVersion: "v0" }))),
		).toBe("unsupported-schema");
	});

	it("defaults to no placement policies rather than refusing", () => {
		const parsed = parseBrokerPolicySet(set());
		expect(parsed.placementPolicies).toEqual([]);
	});

	it("ignores a placement list that is not a list", () => {
		expect(
			parseBrokerPolicySet(set({ placement_policies: "all" }))
				.placementPolicies,
		).toEqual([]);
	});

	it("parses each placement policy through the same boundary", () => {
		expect(
			codeOf(() =>
				parseBrokerPolicySet(
					set({
						placementPolicies: [placement({ objective: "fastest" })],
					}),
				),
			),
		).toBe("invalid-objective");
	});

	it("refuses a required connector kind outside the known set", () => {
		expect(
			codeOf(() =>
				parseBrokerPolicySet(
					set({ required_connector_kinds: ["smoke-signal"] }),
				),
			),
		).toBe("invalid-connector-kind");
	});

	it("supplies in-proc delivery and a zero billing policy by default", () => {
		const parsed = parseBrokerPolicySet(set());
		expect(parsed.delivery.engine).toBe("in-proc");
		expect(parsed.billing.quotaLimit).toBe(0);
	});
});

describe("broker requests", () => {
	const request = (over: JsonObject = {}) => ({
		schemaVersion: BROKER_SCHEMA_VERSION,
		requestId: "r1",
		scope: { bindleId: "app" },
		requirements: [{ resourceId: "db", port: "hobo:sql" }],
		...over,
	});

	it("refuses a request that names no scope, naming the missing block", () => {
		expect(() =>
			parseBrokerRequest({
				schemaVersion: BROKER_SCHEMA_VERSION,
				requestId: "r1",
				requirements: [{ resourceId: "db", port: "hobo:sql" }],
			}),
		).toThrow(
			expect.objectContaining({
				code: "invalid-request",
				message: expect.stringMatching(/scope is required/u),
			}),
		);
	});

	it("refuses a request that places nothing", () => {
		expect(
			codeOf(() => parseBrokerRequest(request({ requirements: [] }))),
		).toBe("empty-requirements");
		expect(
			codeOf(() => parseBrokerRequest(request({ requirements: {} }))),
		).toBe("empty-requirements");
	});

	it("refuses a schema version it does not implement", () => {
		expect(
			codeOf(() =>
				parseBrokerRequest({
					schema_version: "v0",
					requestId: "r1",
					scope: { bindleId: "app" },
					requirements: [{ resourceId: "db", port: "hobo:sql" }],
				}),
			),
		).toBe("unsupported-schema");
	});

	it("defaults the scope to bindle-only and the estimate to zero", () => {
		const parsed = parseBrokerRequest(request({ scope: { bindleId: "app" } }));
		expect(parsed.scope.campId).toBeUndefined();
		expect(parsed.spendEstimateUsd).toBe(0);
	});

	it("reads the snake_case spelling of the request id and estimate", () => {
		const parsed = parseBrokerRequest({
			schema_version: BROKER_SCHEMA_VERSION,
			request_id: "r2",
			scope: { bindle_id: "app" },
			requirements: [{ resource_id: "db", port: "hobo:sql" }],
			spend_estimate_usd: 12.5,
		});
		expect(parsed.requestId).toBe("r2");
		expect(parsed.spendEstimateUsd).toBe(12.5);
		expect(parsed.requirements[0]?.resourceId).toBe("db");
	});
});

describe("topology scopes and requirements", () => {
	it("omits absent scope levels rather than carrying undefined keys", () => {
		const parsed = parseTopologyScope({ bindle_id: "app" });
		expect(Object.keys(parsed)).toEqual(["bindleId"]);
	});

	it("reads every scope level in either spelling", () => {
		const parsed = parseTopologyScope({
			bindleId: "app",
			camp_id: "c",
			yard_id: "y",
			junction_id: "j",
		});
		expect(parsed).toEqual({
			bindleId: "app",
			campId: "c",
			yardId: "y",
			junctionId: "j",
		});
	});

	it("drops non-string entries from a feature list instead of refusing", () => {
		const parsed = parseResourceRequirement({
			resourceId: "db",
			port: "hobo:sql",
			features: ["ha", 7, "", null, "backup"],
		});
		expect(parsed.features).toEqual(["ha", "backup"]);
	});

	it("requires a port", () => {
		expect(codeOf(() => parseResourceRequirement({ resourceId: "db" }))).toBe(
			"invalid-requirement",
		);
	});
});

describe("layering placement policies", () => {
	function policies(...layers: JsonObject[]) {
		return parseBrokerPolicySet({
			schemaVersion: BROKER_SCHEMA_VERSION,
			brokerId: "b1",
			billing: { quota: "standard" },
			placementPolicies: layers,
		});
	}

	const scope: TopologyScope = {
		bindleId: "app",
		campId: "c",
		yardId: "y",
		junctionId: "j",
	};

	it("returns nothing when no layer applies to the scope", () => {
		expect(
			effectivePlacementPolicy(
				policies(placement({ id: "j1", scopeKind: "junction" })),
				{ bindleId: "app" },
			),
		).toBeUndefined();
	});

	it("lets the narrower layer win a choice-shaped field", () => {
		const merged = effectivePlacementPolicy(
			policies(
				placement({ id: "j1", scopeKind: "junction", objective: "min-cost" }),
				placement({
					id: "b1",
					scopeKind: "bindle",
					objective: "pinned",
					pinnedProviderId: "aws",
				}),
			),
			scope,
		);
		expect(merged?.objective).toBe("pinned");
		expect(merged?.id).toBe("b1");
	});

	it("accumulates denied providers instead of replacing them", () => {
		const merged = effectivePlacementPolicy(
			policies(
				placement({
					id: "j1",
					scopeKind: "junction",
					deniedProviders: ["aws"],
				}),
				placement({
					id: "b1",
					scopeKind: "bindle",
					deniedProviders: ["gcp"],
				}),
			),
			scope,
		);
		expect([...(merged?.deniedProviders ?? [])].sort()).toEqual(["aws", "gcp"]);
	});

	it("cannot have an outer explicit-camp lockdown switched off inward", () => {
		const merged = effectivePlacementPolicy(
			policies(
				placement({
					id: "j1",
					scopeKind: "junction",
					requireExplicitCamps: true,
				}),
				placement({
					id: "b1",
					scopeKind: "bindle",
					requireExplicitCamps: false,
				}),
			),
			scope,
		);
		expect(merged?.requireExplicitCamps).toBe(true);
	});

	it("keeps an outer allow-list when the narrower layer states none", () => {
		const merged = effectivePlacementPolicy(
			policies(
				placement({
					id: "j1",
					scopeKind: "junction",
					allowedProviders: ["aws"],
				}),
				placement({ id: "b1", scopeKind: "bindle" }),
			),
			scope,
		);
		expect(merged?.allowedProviders).toEqual(["aws"]);
	});

	it("records every contributing layer, outermost first", () => {
		const merged = effectivePlacementPolicy(
			policies(
				placement({ id: "b1", scopeKind: "bindle" }),
				placement({ id: "j1", scopeKind: "junction" }),
				placement({ id: "y1", scopeKind: "yard" }),
			),
			scope,
		);
		expect(merged?.contributingPolicyIds).toEqual(["j1", "y1", "b1"]);
	});
});
