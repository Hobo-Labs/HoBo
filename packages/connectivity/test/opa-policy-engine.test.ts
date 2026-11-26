/**
 * This adapter has a three-rung ladder: HTTP to a running OPA, then the `opa
 * eval` CLI, then an in-process rego-lite fallback. The ladder exists so a
 * policy decision is always available — but that is exactly what makes it
 * dangerous, because *every* rung must fail closed. A transport error that fell
 * through to "allow" would turn an OPA outage into an authorisation bypass, and
 * nothing about the happy path would look different.
 *
 * So the tests here drive each rung's failure into the next, and check the
 * shape of the answer at every step: a non-ok response, a rejecting fetch, a
 * malformed body, an empty result. The `fromOpaResult` mapping gets the same
 * treatment — a bare `false`, an object without `allow`, and a result that is
 * neither must all deny, because the only safe reading of "I don't understand
 * this policy answer" is no.
 *
 * The rego-lite fallback is covered separately for its own two rules: the
 * `require:*` resource-tag check and the `*.admin` action guard.
 */
import type { PolicyRequest } from "@hobo/core";
import { describe, expect, test } from "vitest";

import {
	createOpaPolicyEngine,
	defaultRegoLikeEval,
	OPA_POLICY_ENGINE_ID,
	SAMPLE_HOBO_AUTHZ_REGO,
} from "../src/policy/opa-engine.js";

function request(
	overrides: {
		subjectTags?: string[];
		subjectTenant?: string;
		resourceTags?: string[];
		resourceTenant?: string;
		action?: string;
		subjectAttributes?: Record<string, unknown>;
		resourceAttributes?: Record<string, unknown>;
		context?: Record<string, unknown>;
	} = {},
): PolicyRequest {
	return {
		subject: {
			identity: "spiffe://yard/tenant-a/agent/deployer",
			tenantId: overrides.subjectTenant ?? "tenant-a",
			tags: overrides.subjectTags ?? [],
			...(overrides.subjectAttributes !== undefined
				? { attributes: overrides.subjectAttributes }
				: {}),
		},
		action: overrides.action ?? "database.read",
		resource: {
			kind: "database",
			id: "shop.db",
			tenantId: overrides.resourceTenant ?? "tenant-a",
			...(overrides.resourceTags !== undefined
				? { tags: overrides.resourceTags }
				: {}),
			...(overrides.resourceAttributes !== undefined
				? { attributes: overrides.resourceAttributes }
				: {}),
		},
		...(overrides.context !== undefined ? { context: overrides.context } : {}),
	} as PolicyRequest;
}

/** A fetch stub that records calls and answers with a fixed response. */
function stubFetch(response: {
	ok?: boolean;
	status?: number;
	json?: () => Promise<unknown>;
}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, ...(init !== undefined ? { init } : {}) });
		return {
			ok: response.ok ?? true,
			status: response.status ?? 200,
			json: response.json ?? (async () => ({})),
		};
	}) as unknown as typeof fetch & {
		calls: Array<{ url: string; init?: RequestInit }>;
	};
	(impl as unknown as { calls: unknown }).calls = calls;
	return impl as typeof fetch & {
		calls: Array<{ url: string; init?: RequestInit }>;
	};
}

const OPA_URL = "http://127.0.0.1:8181/v1/data/hobo/authz/allow";

describe("the HTTP rung", () => {
	test("a boolean true result allows", async () => {
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({ result: true }) }),
		});
		const decision = await engine.evaluate(request());
		expect(decision.effect).toBe("allow");
		expect(decision.reasons).toContain("opa:allow");
	});

	test("a boolean false result denies", async () => {
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({ result: false }) }),
		});
		const decision = await engine.evaluate(request());
		expect(decision.effect).toBe("deny");
		expect(decision.reasons).toContain("opa:deny");
	});

	test("an object result with allow true allows and carries its reasons", async () => {
		// The reasons are what an operator reads to understand a decision; a
		// mapping that dropped them would leave every allow unexplained.
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => ({
					result: {
						allow: true,
						reasons: ["same-tenant"],
						obligations: ["log"],
					},
				}),
			}),
		});
		const decision = await engine.evaluate(request());
		expect(decision.effect).toBe("allow");
		expect(decision.reasons).toEqual(["same-tenant"]);
		expect(decision.obligations).toEqual(["log"]);
	});

	test("an object result with allow false denies with its reasons", async () => {
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => ({
					result: { allow: false, reasons: ["cross-tenant"] },
				}),
			}),
		});
		const decision = await engine.evaluate(request());
		expect(decision.effect).toBe("deny");
		expect(decision.reasons).toEqual(["cross-tenant"]);
	});

	test("an object result with no allow field denies", async () => {
		// Absent is not permission. Only an explicit `allow === true` allows,
		// which is what keeps a partially-written policy from opening access.
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => ({ result: { reasons: ["x"] } }),
			}),
		});
		expect((await engine.evaluate(request())).effect).toBe("deny");
	});

	test("a truthy non-boolean allow does not allow", async () => {
		// `allow: "true"` from a mis-typed policy must not be coerced — the check
		// is `=== true` and this pins that it stays that way.
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => ({ result: { allow: "true" } }),
			}),
		});
		expect((await engine.evaluate(request())).effect).toBe("deny");
	});

	test("an absent result denies with an empty-result reason", async () => {
		// OPA returns no `result` key when the queried path is undefined — a
		// typo'd policy path. Denying with a distinguishable reason is what lets
		// an operator tell that apart from a policy that genuinely said no.
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({}) }),
		});
		const decision = await engine.evaluate(request());
		expect(decision.effect).toBe("deny");
		expect(decision.reasons).toContain("opa:empty-result");
	});

	test("a null or string result denies", async () => {
		for (const result of [null, "yes", 42]) {
			const engine = createOpaPolicyEngine({
				opaUrl: OPA_URL,
				fetchImpl: stubFetch({ json: async () => ({ result }) }),
			});
			expect((await engine.evaluate(request())).effect).toBe("deny");
		}
	});

	test("a non-ok response falls through to the in-process fallback", async () => {
		// A 500 from OPA is not a denial — it is an absence of an answer, and the
		// ladder exists so the next rung supplies one.
		let fallbackCalls = 0;
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ ok: false, status: 500 }),
			fallback: (req) => {
				fallbackCalls += 1;
				return {
					effect: "deny",
					engineId: OPA_POLICY_ENGINE_ID,
					reasons: ["fallback"],
					request: req,
				} as never;
			},
		});
		await engine.evaluate(request());
		expect(fallbackCalls).toBe(1);
	});

	test("a rejecting transport falls through rather than throwing", async () => {
		// If this propagated, an OPA outage would crash every request path
		// instead of degrading to the local policy.
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		const decision = await engine.evaluate(request());
		expect(decision.engineId).toBe(OPA_POLICY_ENGINE_ID);
		expect(["allow", "deny"]).toContain(decision.effect);
	});

	test("a body that is not JSON falls through", async () => {
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => {
					throw new SyntaxError("unexpected token");
				},
			}),
		});
		let fell = false;
		const withFallback = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => {
					throw new SyntaxError("unexpected token");
				},
			}),
			fallback: (req) => {
				fell = true;
				return {
					effect: "deny",
					engineId: OPA_POLICY_ENGINE_ID,
					reasons: ["fallback"],
					request: req,
				} as never;
			},
		});
		await engine.evaluate(request());
		await withFallback.evaluate(request());
		expect(fell).toBe(true);
	});

	test("with no OPA url configured the HTTP rung is skipped entirely", async () => {
		// The common offline case: no network call should be attempted at all.
		const fetchImpl = stubFetch({ json: async () => ({ result: true }) });
		const engine = createOpaPolicyEngine({ fetchImpl });
		await engine.evaluate(request());
		expect(fetchImpl.calls).toHaveLength(0);
	});

	test("the request is posted as JSON under an input key", async () => {
		// OPA's document API expects `{ input }`; sending the request bare would
		// make every policy see an undefined input and deny everything.
		const fetchImpl = stubFetch({ json: async () => ({ result: true }) });
		const engine = createOpaPolicyEngine({ opaUrl: OPA_URL, fetchImpl });
		await engine.evaluate(request());
		const call = fetchImpl.calls[0];
		expect(call?.url).toBe(OPA_URL);
		expect(call?.init?.method).toBe("POST");
		const body = JSON.parse(String(call?.init?.body));
		expect(body.input).toBeDefined();
	});
});

describe("the OPA input mapping", () => {
	async function inputFor(req: PolicyRequest) {
		const fetchImpl = stubFetch({ json: async () => ({ result: true }) });
		await createOpaPolicyEngine({ opaUrl: OPA_URL, fetchImpl }).evaluate(req);
		return JSON.parse(String(fetchImpl.calls[0]?.init?.body)).input as Record<
			string,
			Record<string, unknown>
		>;
	}

	test("tenant ids are snake_cased for Rego", async () => {
		// Rego policies are written against `input.subject.tenant_id`. Sending
		// camelCase would make every tenant comparison silently undefined —
		// which, against the sample policy, denies everything.
		const input = await inputFor(request());
		expect(input.subject?.tenant_id).toBe("tenant-a");
		expect(input.resource?.tenant_id).toBe("tenant-a");
	});

	test("absent attributes and tags become empty rather than undefined", async () => {
		// A Rego rule indexing into an undefined object errors rather than
		// evaluating; the defaults keep a sparse request policy-evaluable.
		const input = await inputFor(request());
		expect(input.subject?.attributes).toEqual({});
		expect(input.resource?.attributes).toEqual({});
		expect(input.resource?.tags).toEqual([]);
		expect(input.context).toEqual({});
	});

	test("supplied attributes, tags and context are passed through", async () => {
		const input = await inputFor(
			request({
				subjectAttributes: { level: "senior" },
				resourceAttributes: { shared: "true" },
				resourceTags: ["shared:true"],
				context: { hour: 3 },
			}),
		);
		expect(input.subject?.attributes).toEqual({ level: "senior" });
		expect(input.resource?.attributes).toEqual({ shared: "true" });
		expect(input.resource?.tags).toEqual(["shared:true"]);
		expect(input.context).toEqual({ hour: 3 });
	});

	test("the subject identity and action reach the input", async () => {
		const input = await inputFor(request({ action: "database.admin" }));
		expect(input.subject?.identity).toBe(
			"spiffe://yard/tenant-a/agent/deployer",
		);
		expect(input.action).toBe("database.admin");
	});
});

describe("the rego-lite fallback", () => {
	test("a resource require: tag the subject lacks denies", () => {
		// This is the local authorisation rule. A resource tagged
		// `require:role:dba` must not be reachable by a subject without it.
		const decision = defaultRegoLikeEval(
			request({ resourceTags: ["require:role:dba"], subjectTags: [] }),
		);
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toContain("role:dba");
	});

	test("a require: tag the subject holds does not deny on that ground", () => {
		// The tag is stripped of its `require:` prefix before comparison; a
		// mismatch there would make every requirement unsatisfiable.
		const decision = defaultRegoLikeEval(
			request({
				resourceTags: ["require:role:dba"],
				subjectTags: ["role:dba"],
			}),
		);
		expect(decision.reasons.join(" ")).not.toContain("missing tags");
	});

	test("every missing requirement is named, not just the first", () => {
		// An operator fixing one tag only to hit the next is a bad loop; the
		// message lists them all.
		const decision = defaultRegoLikeEval(
			request({
				resourceTags: ["require:role:dba", "require:mfa", "unrelated"],
				subjectTags: ["role:dba"],
			}),
		);
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toContain("require:mfa");
	});

	test("non-require resource tags are ignored", () => {
		const decision = defaultRegoLikeEval(
			request({ resourceTags: ["env:prod", "team:core"] }),
		);
		expect(decision.reasons.join(" ")).not.toContain("missing tags");
	});

	test("a resource with no tags imposes no requirement", () => {
		const decision = defaultRegoLikeEval(request());
		expect(decision.reasons.join(" ")).not.toContain("missing tags");
	});

	test("an .admin action without role:admin denies", () => {
		// The second local rule, and the one that most needs to hold when OPA is
		// unreachable: administrative actions are not available by default.
		const decision = defaultRegoLikeEval(
			request({ action: "database.admin", subjectTags: [] }),
		);
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toContain("role:admin");
	});

	test("an .admin action with role:admin passes that check", () => {
		const decision = defaultRegoLikeEval(
			request({ action: "database.admin", subjectTags: ["role:admin"] }),
		);
		expect(decision.reasons.join(" ")).not.toContain("role:admin required");
	});

	test("the admin guard matches on the suffix, not a substring", () => {
		// `database.administer` is not an admin action; treating it as one would
		// lock out ordinary operations under a misleading reason.
		const decision = defaultRegoLikeEval(
			request({ action: "database.administer", subjectTags: [] }),
		);
		expect(decision.reasons.join(" ")).not.toContain("role:admin required");
	});

	test("the tag requirement is checked before the admin guard", () => {
		// Both would deny, but the tag message is the more specific one and the
		// one an operator can act on directly.
		const decision = defaultRegoLikeEval(
			request({
				action: "database.admin",
				resourceTags: ["require:role:dba"],
				subjectTags: [],
			}),
		);
		expect(decision.reasons.join(" ")).toContain("role:dba");
	});

	test("same tenant alone is not enough — every allow rule also needs same env", () => {
		// Worth stating plainly, because "same tenant" is the intuitive reading
		// and it is wrong: all three allow rules in the default document carry
		// `sameEnv: true`, and env comes from an `env:` tag on both sides. A
		// request that names no env has `subjectEnv === null`, so `sameEnv` is
		// false and the document falls through to its deny default.
		//
		// That is the fail-closed direction, and it matters most exactly when
		// this code runs: the fallback is what answers while OPA is unreachable,
		// so it must not be more permissive than OPA would have been.
		const decision = defaultRegoLikeEval(
			request({ subjectTenant: "tenant-a", resourceTenant: "tenant-a" }),
		);
		expect(decision.effect).toBe("deny");
	});

	test("same tenant and same env together are allowed", () => {
		const decision = defaultRegoLikeEval(
			request({
				subjectTenant: "tenant-a",
				resourceTenant: "tenant-a",
				subjectTags: ["env:production"],
				resourceTags: ["env:production"],
			}),
		);
		expect(decision.effect).toBe("allow");
		expect(decision.reasons.join(" ")).toContain("same-tenant");
	});

	test("a cross-tenant request is denied even within one env", () => {
		// Tenant isolation is the default document's core rule; without it the
		// offline fallback would let one tenant reach another's resources.
		const decision = defaultRegoLikeEval(
			request({
				subjectTenant: "tenant-a",
				resourceTenant: "tenant-b",
				subjectTags: ["env:production"],
				resourceTags: ["env:production"],
			}),
		);
		expect(decision.effect).toBe("deny");
	});

	test("a cross-env request is denied even within one tenant", () => {
		// The other half of the same rule: a development principal must not
		// reach a production resource just because they share a tenant.
		const decision = defaultRegoLikeEval(
			request({
				subjectTenant: "tenant-a",
				resourceTenant: "tenant-a",
				subjectTags: ["env:development"],
				resourceTags: ["env:production"],
			}),
		);
		expect(decision.effect).toBe("deny");
	});

	test("a shared resource in the same env is allowed across tenants", () => {
		// The third allow rule, and the only one that crosses a tenant boundary
		// — so it is the one most worth pinning as deliberate.
		const decision = defaultRegoLikeEval(
			request({
				subjectTenant: "tenant-a",
				resourceTenant: "tenant-b",
				subjectTags: ["env:production"],
				resourceTags: ["env:production", "shared:true"],
			}),
		);
		expect(decision.effect).toBe("allow");
		expect(decision.reasons.join(" ")).toContain("shared");
	});

	test("a shared resource in a different env is still denied", () => {
		const decision = defaultRegoLikeEval(
			request({
				subjectTenant: "tenant-a",
				resourceTenant: "tenant-b",
				subjectTags: ["env:development"],
				resourceTags: ["env:production", "shared:true"],
			}),
		);
		expect(decision.effect).toBe("deny");
	});

	test("every fallback decision is attributed to this engine", () => {
		// The engine id is how an audit says which policy path produced a
		// decision; an unattributed one cannot be traced back to the fallback.
		expect(defaultRegoLikeEval(request()).engineId).toBe(OPA_POLICY_ENGINE_ID);
	});

	test("the engine reports its pinned id", () => {
		expect(createOpaPolicyEngine().engineId).toBe(OPA_POLICY_ENGINE_ID);
	});
});

describe("metering", () => {
	function meteringBus() {
		const emitted: Array<Record<string, unknown>> = [];
		return {
			bus: {
				async emit(event: Record<string, unknown>) {
					emitted.push(event);
				},
			},
			emitted,
		};
	}

	test("a decision is metered with its effect and action", async () => {
		// Policy evaluation is billed and rate-limited; an unmetered decision is
		// free capacity nobody accounts for.
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({
			metering: bus as never,
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({ result: true }) }),
		});
		await engine.evaluate(request({ action: "database.read" }));
		expect(emitted).toHaveLength(1);
		const metadata = (emitted[0] as { metadata?: Record<string, unknown> })
			.metadata;
		expect(metadata?.effect).toBe("allow");
		expect(metadata?.action).toBe("database.read");
		expect(metadata?.engineId).toBe(OPA_POLICY_ENGINE_ID);
	});

	test("a denial is metered too", async () => {
		// Metering only the allows would under-count exactly the traffic worth
		// watching.
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({
			metering: bus as never,
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({ result: false }) }),
		});
		await engine.evaluate(request());
		expect(
			(emitted[0] as { metadata?: Record<string, unknown> }).metadata?.effect,
		).toBe("deny");
	});

	test("a fallback decision is metered as well", async () => {
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({ metering: bus as never });
		await engine.evaluate(request());
		expect(emitted).toHaveLength(1);
	});

	test("the usage event is scoped to the subject's tenant", async () => {
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({ metering: bus as never });
		await engine.evaluate(request({ subjectTenant: "tenant-z" }));
		expect((emitted[0] as { tenantId?: string }).tenantId).toBe("tenant-z");
	});

	test("the resource is recorded as kind:id", async () => {
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({ metering: bus as never });
		await engine.evaluate(request());
		expect((emitted[0] as { resource?: string }).resource).toBe(
			"database:shop.db",
		);
	});

	test("with no metering bus nothing is emitted and evaluation still works", async () => {
		const engine = createOpaPolicyEngine();
		await expect(engine.evaluate(request())).resolves.toBeDefined();
	});
});

describe("the sample Rego module", () => {
	test("it declares a default-deny policy", () => {
		// The sample is copied into real deployments; one that defaulted to allow
		// would ship an open policy to whoever pasted it.
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("default allow := false");
	});

	test("it is written against the snake_cased input this adapter sends", () => {
		// The sample and `toOpaInput` have to agree, or the documented policy
		// denies every request against the real input shape.
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("input.subject.tenant_id");
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("input.resource.tenant_id");
	});

	test("it declares the hobo.authz package the default query path expects", () => {
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("package hobo.authz");
	});
});
