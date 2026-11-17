import { type PolicyRequest, parseTenantId, type UsageEvent } from "@hobo/core";
import { describe, expect, test } from "vitest";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
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
		subjectAttributes?: Record<string, string>;
		resourceAttributes?: Record<string, string>;
		context?: JsonObject;
	} = {},
): PolicyRequest {
	return {
		subject: {
			identity: "spiffe://yard/tenant-a/agent/deployer",
			tenantId: parseTenantId(overrides.subjectTenant ?? "tenant-a"),
			tags: overrides.subjectTags ?? [],
			...(overrides.subjectAttributes !== undefined
				? { attributes: overrides.subjectAttributes }
				: undefined),
		},
		action: overrides.action ?? "database.read",
		resource: {
			kind: "database",
			id: "shop.db",
			tenantId: parseTenantId(overrides.resourceTenant ?? "tenant-a"),
			...(overrides.resourceTags !== undefined
				? { tags: overrides.resourceTags }
				: undefined),
			...(overrides.resourceAttributes !== undefined
				? { attributes: overrides.resourceAttributes }
				: undefined),
		},
		...(overrides.context !== undefined
			? { context: overrides.context }
			: undefined),
	};
}

function stubFetch(response: {
	ok?: boolean;
	status?: number;
	json?: () => Promise<JsonValue>;
}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, ...(init !== undefined ? { init } : undefined) });
		const status = response.status ?? (response.ok === false ? 500 : 200);
		const result = new Response(null, { status });
		result.json = response.json ?? (async () => ({}));
		return result;
	};
	return Object.assign(impl, { calls });
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
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => ({ result: { reasons: ["x"] } }),
			}),
		});
		expect((await engine.evaluate(request())).effect).toBe("deny");
	});

	test("a truthy non-boolean allow does not allow", async () => {
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({
				json: async () => ({ result: { allow: "true" } }),
			}),
		});
		expect((await engine.evaluate(request())).effect).toBe("deny");
	});

	test("an absent result denies with an empty-result reason", async () => {
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
		const engine = createOpaPolicyEngine({
			opaUrl: OPA_URL,
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
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
		const fetchImpl = stubFetch({ json: async () => ({ result: true }) });
		const engine = createOpaPolicyEngine({ fetchImpl });
		await engine.evaluate(request());
		expect(fetchImpl.calls).toHaveLength(0);
	});

	test("the request is posted as JSON under an input key", async () => {
		const fetchImpl = stubFetch({ json: async () => ({ result: true }) });
		const engine = createOpaPolicyEngine({ opaUrl: OPA_URL, fetchImpl });
		await engine.evaluate(request());
		const call = fetchImpl.calls[0];
		expect(call?.url).toBe(OPA_URL);
		expect(call?.init?.method).toBe("POST");
		const body = parseJsonObject(String(call?.init?.body));
		expect(body.input).toBeDefined();
	});
});

describe("the OPA input mapping", () => {
	async function inputFor(req: PolicyRequest) {
		const fetchImpl = stubFetch({ json: async () => ({ result: true }) });
		await createOpaPolicyEngine({ opaUrl: OPA_URL, fetchImpl }).evaluate(req);
		const input = parseJsonObject(String(fetchImpl.calls[0]?.init?.body)).input;
		if (
			!isJsonObject(input) ||
			!isJsonObject(input.subject) ||
			!isJsonObject(input.resource)
		) {
			throw new TypeError("expected policy input with subject and resource");
		}
		return {
			subject: input.subject,
			resource: input.resource,
			context: input.context,
			action: input.action,
		};
	}

	test("tenant ids are snake_cased for Rego", async () => {
		const input = await inputFor(request());
		expect(input.subject?.tenant_id).toBe("tenant-a");
		expect(input.resource?.tenant_id).toBe("tenant-a");
	});

	test("absent attributes and tags become empty rather than undefined", async () => {
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
		const decision = defaultRegoLikeEval(
			request({ resourceTags: ["require:role:dba"], subjectTags: [] }),
		);
		expect(decision.effect).toBe("deny");
		expect(decision.reasons.join(" ")).toContain("role:dba");
	});

	test("a require: tag the subject holds does not deny on that ground", () => {
		const decision = defaultRegoLikeEval(
			request({
				resourceTags: ["require:role:dba"],
				subjectTags: ["role:dba"],
			}),
		);
		expect(decision.reasons.join(" ")).not.toContain("missing tags");
	});

	test("every missing requirement is named, not just the first", () => {
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
		const decision = defaultRegoLikeEval(
			request({ action: "database.administer", subjectTags: [] }),
		);
		expect(decision.reasons.join(" ")).not.toContain("role:admin required");
	});

	test("the tag requirement is checked before the admin guard", () => {
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
		expect(defaultRegoLikeEval(request()).engineId).toBe(OPA_POLICY_ENGINE_ID);
	});

	test("the engine reports its pinned id", () => {
		expect(createOpaPolicyEngine().engineId).toBe(OPA_POLICY_ENGINE_ID);
	});
});

describe("metering", () => {
	function meteringBus() {
		const emitted: UsageEvent[] = [];
		return {
			bus: {
				async emit(event: UsageEvent) {
					emitted.push(event);
				},
			},
			emitted,
		};
	}

	test("a decision is metered with its effect and action", async () => {
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({
			metering: bus as never,
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({ result: true }) }),
		});
		await engine.evaluate(request({ action: "database.read" }));
		expect(emitted).toHaveLength(1);
		const metadata = emitted[0]?.metadata;
		expect(metadata?.effect).toBe("allow");
		expect(metadata?.action).toBe("database.read");
		expect(metadata?.engineId).toBe(OPA_POLICY_ENGINE_ID);
	});

	test("a denial is metered too", async () => {
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({
			metering: bus as never,
			opaUrl: OPA_URL,
			fetchImpl: stubFetch({ json: async () => ({ result: false }) }),
		});
		await engine.evaluate(request());
		expect(emitted[0]?.metadata?.effect).toBe("deny");
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
		expect(emitted[0]?.tenantId).toBe("tenant-z");
	});

	test("the resource is recorded as kind:id", async () => {
		const { bus, emitted } = meteringBus();
		const engine = createOpaPolicyEngine({ metering: bus as never });
		await engine.evaluate(request());
		expect(emitted[0]?.resource).toBe("database:shop.db");
	});

	test("with no metering bus nothing is emitted and evaluation still works", async () => {
		const engine = createOpaPolicyEngine();
		await expect(engine.evaluate(request())).resolves.toBeDefined();
	});
});

describe("the sample Rego module", () => {
	test("it declares a default-deny policy", () => {
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("default allow := false");
	});

	test("it is written against the snake_cased input this adapter sends", () => {
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("input.subject.tenant_id");
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("input.resource.tenant_id");
	});

	test("it declares the hobo.authz package the default query path expects", () => {
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("package hobo.authz");
	});
});
