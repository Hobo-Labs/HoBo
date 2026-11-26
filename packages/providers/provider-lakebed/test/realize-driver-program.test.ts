/**
 * Realizing provider-neutral plans into a Lakebed deploy-driver program.
 *
 * Lakebed is a closed PaaS: it exposes a deploy surface, not infrastructure
 * state, so HoBo emits a *driver program* rather than IaC (ADR-0127). That
 * distinction shapes what has to be right here.
 *
 * **Output references have to resolve.** A driver program's outputs are
 * `${resources.<name>.outputs.<field>}` strings that Lakebed dereferences at
 * deploy time. A reference to a resource that is not in the program, or to a
 * field that resource does not declare, is a deploy that fails *inside
 * Lakebed* with an error about a template — so `assertDriverProgram` resolves
 * every one before the program leaves this package.
 *
 * **Foreign option blocks drop rather than pass through.** A `.with(...)`
 * block belongs to whichever provider it names, and forwarding another
 * provider's options into a Lakebed deploy call would send Lakebed
 * configuration it cannot interpret — at best ignored, at worst rejected.
 *
 * **A single-resource plan and a multi-resource one bind differently.** One
 * resource has nothing to bind *to*, so its deps become opaque provider
 * resource ids; a multi-resource program can resolve them as references
 * across the same deploy. Emitting a reference in the single-resource case
 * would produce exactly the unresolvable output the assert exists to catch.
 *
 * Ids that reach Lakebed are sanitized: a plan id is HoBo's, and it may carry
 * characters a capsule name cannot.
 */
import { describe, expect, it } from "vitest";

import {
	assertDriverProgram,
	DRIVER_PROGRAM_API_VERSION,
	DRIVER_PROGRAM_KIND,
	type DriverProgram,
	LAKEBED_DRIVER,
} from "../src/driver-program.js";
import { LAKEBED_PROVIDER_TARGET } from "../src/options.js";
import {
	isRealizablePort,
	mergeLakebedOptions,
	realizeResourcePlan,
	realizeResourcePlans,
	realizeTrafficRoutingPlan,
	resolveEquivalence,
} from "../src/realize.js";
import type { ResourcePlan } from "../src/types.js";

const plan = (overrides: Partial<ResourcePlan> = {}): ResourcePlan =>
	({ name: "web", port: "compute", ...overrides }) as ResourcePlan;

/** A minimal valid driver program, for assert tests that vary one field. */
const program = (overrides: Partial<DriverProgram> = {}): DriverProgram => ({
	apiVersion: DRIVER_PROGRAM_API_VERSION,
	kind: DRIVER_PROGRAM_KIND,
	driver: LAKEBED_DRIVER,
	deploymentId: "d1",
	capsule: "capsule/d1",
	resources: [
		{
			name: "web",
			type: "lakebed:capsule",
			provider: LAKEBED_PROVIDER_TARGET,
			inputs: {},
			outputs: ["url", "binding"],
		},
	],
	outputs: { endpoint: "${resources.web.outputs.url}" },
	...overrides,
});

describe("port realizability", () => {
	it("realizes the four capability ports it maps", () => {
		for (const port of ["compute", "kv", "objectStore", "database"]) {
			expect(isRealizablePort(port), port).toBe(true);
			expect(resolveEquivalence(port).resourceClass).toMatch(/^lakebed:/);
		}
	});

	it("refuses a port it has no equivalence class for, naming it", () => {
		// A closed PaaS does not serve every port. Realizing an unmapped one
		// would emit a resource type Lakebed rejects at deploy time, with an
		// error naming a type nobody wrote.
		expect(isRealizablePort("queue")).toBe(false);
		expect(() => resolveEquivalence("queue")).toThrow(
			/cannot realize port queue/,
		);
	});

	it("maps each port to a distinct resource class", () => {
		// Two ports collapsing to one class would deploy a KV namespace where a
		// database was asked for.
		const classes = ["compute", "kv", "objectStore", "database"].map(
			(port) => resolveEquivalence(port).resourceClass,
		);
		expect(new Set(classes).size).toBe(4);
	});
});

describe("mergeLakebedOptions", () => {
	it("merges the option blocks that name Lakebed", () => {
		expect(
			mergeLakebedOptions([
				{ providerId: LAKEBED_PROVIDER_TARGET, options: { region: "eu" } },
				{ providerId: LAKEBED_PROVIDER_TARGET, options: { memory: 512 } },
			] as never),
		).toEqual({ region: "eu", memory: 512 });
	});

	it("drops a block belonging to another provider", () => {
		// Forwarding a Vercel block into a Lakebed deploy call would send
		// configuration Lakebed cannot interpret.
		expect(
			mergeLakebedOptions([
				{ providerId: "vercel", options: { regions: ["iad1"] } },
				{ providerId: LAKEBED_PROVIDER_TARGET, options: { region: "eu" } },
			] as never),
		).toEqual({ region: "eu" });
	});

	it("lets a later Lakebed block win a key collision", () => {
		// Blocks are applied in declaration order, which is the order the
		// builder emitted them — the last `.with(...)` is the user's final word.
		expect(
			mergeLakebedOptions([
				{ providerId: LAKEBED_PROVIDER_TARGET, options: { region: "eu" } },
				{ providerId: LAKEBED_PROVIDER_TARGET, options: { region: "us" } },
			] as never),
		).toEqual({ region: "us" });
	});

	it("returns nothing for no blocks at all", () => {
		expect(mergeLakebedOptions()).toEqual({});
		expect(mergeLakebedOptions([])).toEqual({});
	});
});

describe("realizeResourcePlan", () => {
	it("emits a one-resource driver program at the pinned contract", () => {
		const { driver } = realizeResourcePlan(plan());
		expect(driver.apiVersion).toBe(DRIVER_PROGRAM_API_VERSION);
		expect(driver.kind).toBe(DRIVER_PROGRAM_KIND);
		expect(driver.driver).toBe(LAKEBED_DRIVER);
		expect(driver.resources).toHaveLength(1);
	});

	it("names the capsule after the deployment", () => {
		// The capsule is the deploy unit. A mismatch would deploy into a capsule
		// unrelated to the deployment id everything else records.
		const { driver } = realizeResourcePlan(
			plan({ deploymentId: "prod-web" } as never),
		);
		expect(driver.deploymentId).toBe("prod-web");
		expect(driver.capsule).toBe("capsule/prod-web");
	});

	it("falls back to the resource name when no deployment id is given", () => {
		const { driver } = realizeResourcePlan(plan({ name: "api" }));
		expect(driver.deploymentId).toBe("api");
		expect(driver.capsule).toBe("capsule/api");
	});

	it("carries the port, service, and features into the resource inputs", () => {
		// Lakebed picks its own service from these; dropping the features would
		// deploy a capsule without the capabilities the port promised.
		const { driver } = realizeResourcePlan(plan());
		const inputs = driver.resources[0]?.inputs as Record<string, unknown>;
		expect(inputs.port).toBe("compute");
		expect(inputs.providerService).toBeTruthy();
		expect(Array.isArray(inputs.features)).toBe(true);
	});

	it("declares the outputs its resource class actually produces", () => {
		// The output list is what an output reference is resolved against.
		expect(realizeResourcePlan(plan()).driver.resources[0]?.outputs).toEqual([
			"url",
			"capsuleId",
			"binding",
		]);
		expect(
			realizeResourcePlan(plan({ port: "kv" })).driver.resources[0]?.outputs,
		).toEqual(["namespace", "binding"]);
	});

	it("points its endpoint output at the class's primary field", () => {
		// A capsule's endpoint is its URL; a KV's is its namespace. One shared
		// field name would resolve to a value that is not an endpoint.
		expect(realizeResourcePlan(plan()).driver.outputs).toEqual({
			"web.endpoint": "${resources.web.outputs.url}",
		});
		expect(
			realizeResourcePlan(plan({ name: "cache", port: "kv" })).driver.outputs,
		).toEqual({ "cache.endpoint": "${resources.cache.outputs.namespace}" });
	});

	it("emits deps as opaque provider resource ids, not references", () => {
		// A single-resource program has nothing to resolve a reference against.
		// Emitting one would produce exactly the unresolvable output the assert
		// exists to catch.
		const { driver } = realizeResourcePlan(plan({ deps: ["cache"] } as never));
		expect(
			(driver.resources[0]?.inputs as { bindings: unknown }).bindings,
		).toEqual([{ providerResourceId: "cache" }]);
	});

	it("emits no bindings when the plan declares no deps", () => {
		expect(
			(
				realizeResourcePlan(plan()).driver.resources[0]?.inputs as {
					bindings: unknown;
				}
			).bindings,
		).toEqual([]);
	});

	it("produces a program its own assert accepts", () => {
		// Realize and assert are two halves of one contract. A realize the
		// assert rejects would make every deploy fail at the boundary.
		for (const port of ["compute", "kv", "objectStore", "database"]) {
			expect(() =>
				assertDriverProgram(realizeResourcePlan(plan({ port })).driver),
			).not.toThrow();
		}
	});
});

describe("realizeResourcePlans", () => {
	it("refuses an empty plan list", () => {
		// A deploy with no resources is a caller mistake, and emitting an empty
		// program would have Lakebed report a successful deploy of nothing.
		expect(() => realizeResourcePlans([])).toThrow(/empty deployment plan/);
	});

	it("emits one resource per plan in order", () => {
		const { driver } = realizeResourcePlans([
			plan({ name: "web" }),
			plan({ name: "cache", port: "kv" }),
		]);
		expect(driver.resources.map((resource) => resource.name)).toEqual([
			"web",
			"cache",
		]);
	});

	it("resolves deps as cross-resource references", () => {
		// This is what makes a multi-resource deploy one call: Lakebed wires the
		// binding itself rather than HoBo needing a second round-trip to learn
		// the cache's identity.
		const { driver } = realizeResourcePlans([
			plan({ name: "web", deps: ["cache"] } as never),
			plan({ name: "cache", port: "kv" }),
		]);
		expect(
			(driver.resources[0]?.inputs as { bindings: unknown }).bindings,
		).toEqual([
			{ resource: "cache", ref: "${resources.cache.outputs.binding}" },
		]);
	});

	it("defaults the deployment id and derives the capsule from it", () => {
		const { driver } = realizeResourcePlans([plan()]);
		expect(driver.deploymentId).toBe("hello-bindle-lakebed");
		expect(driver.capsule).toBe("capsule/hello-bindle-lakebed");
	});

	it("takes an explicit deployment id", () => {
		const { driver } = realizeResourcePlans([plan()], {
			deploymentId: "prod",
		});
		expect(driver.deploymentId).toBe("prod");
		expect(driver.capsule).toBe("capsule/prod");
	});

	it("points the program's endpoint at the first resource", () => {
		// The first plan is the entry point by construction. Pointing at an
		// arbitrary one would report a cache namespace as the app's endpoint.
		const { driver } = realizeResourcePlans([
			plan({ name: "web" }),
			plan({ name: "cache", port: "kv" }),
		]);
		expect(driver.outputs).toEqual({
			endpoint: "${resources.web.outputs.url}",
		});
	});

	it("produces a program its own assert accepts", () => {
		expect(() =>
			assertDriverProgram(
				realizeResourcePlans([
					plan({ name: "web", deps: ["cache"] } as never),
					plan({ name: "cache", port: "kv" }),
				]).driver,
			),
		).not.toThrow();
	});
});

describe("realizeTrafficRoutingPlan", () => {
	const routing = (overrides: Record<string, unknown> = {}) =>
		({
			planId: "plan-1",
			intent: {
				service: "web",
				tenantId: "tenant-a",
				rules: [{ weightStrategy: "even", backends: [{ id: "b1" }] }],
			},
			backends: [{ id: "b1", service: "web" }],
			...overrides,
		}) as never;

	it("emits a traffic-route resource asserting clean", () => {
		// Lakebed has no multi-LB API, so routing intent is expressed as a
		// deploy-time resource rather than a control-plane call.
		const { driver } = realizeTrafficRoutingPlan(routing());
		expect(driver.resources[0]?.type).toBe("lakebed:traffic-route");
		expect(() => assertDriverProgram(driver)).not.toThrow();
	});

	it("sanitizes the plan id into the deployment and resource names", () => {
		// A HoBo plan id may carry characters a capsule name cannot. Passing
		// them through would have Lakebed reject the deploy on a name.
		const { driver } = realizeTrafficRoutingPlan(
			routing({ planId: "plan/one two!" }),
		);
		expect(driver.deploymentId).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(driver.resources[0]?.name).toMatch(/^route-[A-Za-z0-9._-]+$/);
	});

	it("takes an explicit deployment id and capsule over the derived ones", () => {
		const { driver } = realizeTrafficRoutingPlan(routing(), {
			deploymentId: "routing-prod",
			capsule: "capsule/custom",
		});
		expect(driver.deploymentId).toBe("routing-prod");
		expect(driver.capsule).toBe("capsule/custom");
	});

	it("ignores a whitespace-only override", () => {
		// A blank option is not a choice; using it would produce a capsule named
		// by whitespace.
		const { driver } = realizeTrafficRoutingPlan(routing(), {
			deploymentId: "   ",
			capsule: "  ",
		});
		expect(driver.deploymentId).toBe("plan-1");
		expect(driver.capsule).toBe("capsule/web");
	});

	it("falls back when sanitizing leaves nothing", () => {
		// A plan id of only punctuation sanitizes to the empty string, and an
		// empty capsule name is not deployable.
		const { driver } = realizeTrafficRoutingPlan(
			routing({
				planId: "///",
				intent: { service: "!!!", tenantId: "t", rules: [] },
			}),
		);
		expect(driver.deploymentId).toBe("traffic");
		expect(driver.capsule).toBe("capsule/service");
	});

	it("carries each backend, omitting the fields it was not given", () => {
		// An `endpoint: undefined` sent to Lakebed is a field it has to reason
		// about; an absent one is not.
		const { driver } = realizeTrafficRoutingPlan(
			routing({
				backends: [
					{ id: "b1", service: "web" },
					{
						id: "b2",
						service: "web",
						endpoint: "https://b2",
						weight: 30,
						locationHints: ["eu"],
					},
				],
			}),
		);
		const backends = (driver.resources[0]?.inputs as { backends: unknown[] })
			.backends;
		expect(backends[0]).toEqual({ id: "b1", service: "web" });
		expect(backends[1]).toEqual({
			id: "b2",
			service: "web",
			endpoint: "https://b2",
			weight: 30,
			locationHints: ["eu"],
		});
	});

	it("reduces each rule's backends to their ids", () => {
		// The rule references backends the resource already carries in full.
		// Repeating them would let the two copies drift.
		const { driver } = realizeTrafficRoutingPlan(
			routing({
				intent: {
					service: "web",
					tenantId: "t",
					rules: [
						{ weightStrategy: "even", backends: [{ id: "b1" }, { id: "b2" }] },
					],
				},
			}),
		);
		const rules = (driver.resources[0]?.inputs as { rules: unknown[] }).rules;
		expect(rules[0]).toMatchObject({ backends: ["b1", "b2"] });
	});

	it("carries a rule's match only when it has one", () => {
		const withMatch = realizeTrafficRoutingPlan(
			routing({
				intent: {
					service: "web",
					tenantId: "t",
					rules: [
						{
							weightStrategy: "even",
							match: { pathPrefix: "/api", headers: { "x-a": "1" } },
							backends: [{ id: "b1" }],
						},
					],
				},
			}),
		);
		expect(
			(
				withMatch.driver.resources[0]?.inputs as {
					rules: Record<string, unknown>[];
				}
			).rules[0]?.match,
		).toEqual({ pathPrefix: "/api", headers: { "x-a": "1" } });

		const withoutMatch = realizeTrafficRoutingPlan(routing());
		expect(
			(
				withoutMatch.driver.resources[0]?.inputs as {
					rules: Record<string, unknown>[];
				}
			).rules[0],
		).not.toHaveProperty("match");
	});

	it("emits both a routeId and a binding output", () => {
		// The route id identifies the route for later changes; the binding is
		// what another resource attaches to.
		const { driver } = realizeTrafficRoutingPlan(routing());
		expect(Object.keys(driver.outputs).sort()).toEqual(["binding", "routeId"]);
	});
});

describe("assertDriverProgram", () => {
	it("accepts a well-formed program", () => {
		expect(assertDriverProgram(program())).toBeTruthy();
	});

	it("refuses a wrong apiVersion, kind, or driver, naming the expected value", () => {
		// Each pin is a contract with a different consumer: the version with
		// Lakebed's parser, the kind with HoBo's dispatcher, the driver with the
		// deploy runner that executes it.
		expect(() =>
			assertDriverProgram(program({ apiVersion: "v2" } as never)),
		).toThrow(new RegExp(DRIVER_PROGRAM_API_VERSION));
		expect(() =>
			assertDriverProgram(program({ kind: "iac-program" } as never)),
		).toThrow(/kind must be driver-program/);
		expect(() =>
			assertDriverProgram(program({ driver: "terraform" } as never)),
		).toThrow(new RegExp(LAKEBED_DRIVER));
	});

	it("refuses a program with no resources", () => {
		// A deploy of nothing that reports success is worse than a refusal.
		expect(() => assertDriverProgram(program({ resources: [] }))).toThrow(
			/at least one resource/,
		);
		expect(() =>
			assertDriverProgram(program({ resources: undefined as never })),
		).toThrow(/at least one resource/);
	});

	it("refuses a resource with no name", () => {
		// The name is what an output reference resolves against; an unnamed
		// resource is unreferenceable.
		expect(() =>
			assertDriverProgram(
				program({
					resources: [{ ...program().resources[0], name: "" } as never],
					outputs: {},
				}),
			),
		).toThrow(/missing name/);
	});

	it("refuses duplicate resource names, naming the collision", () => {
		// Two resources under one name make every reference to it ambiguous,
		// and Lakebed would resolve to whichever it saw last.
		expect(() =>
			assertDriverProgram(
				program({
					resources: [
						program().resources[0] as never,
						program().resources[0] as never,
					],
				}),
			),
		).toThrow(/duplicate resource web/);
	});

	it("refuses an output referencing a resource that is not in the program", () => {
		// This is the failure the assert exists for: a deploy that fails inside
		// Lakebed with an error about a template rather than about HoBo.
		expect(() =>
			assertDriverProgram(
				program({ outputs: { endpoint: "${resources.gone.outputs.url}" } }),
			),
		).toThrow(/unresolved output reference/);
	});

	it("refuses an output referencing a field the resource does not declare", () => {
		expect(() =>
			assertDriverProgram(
				program({ outputs: { endpoint: "${resources.web.outputs.nope}" } }),
			),
		).toThrow(/unresolved output reference/);
	});

	it("refuses a malformed reference that still looks like one", () => {
		// A half-written template is more dangerous than a plain string: it
		// would reach Lakebed and be interpolated into something unpredictable.
		expect(() =>
			assertDriverProgram(
				program({ outputs: { endpoint: "${resources.web.outputs}" } }),
			),
		).toThrow(/invalid output reference/);
	});

	it("leaves a literal output value alone", () => {
		// Not every output is a reference. A literal endpoint is a legitimate
		// thing for a driver program to carry.
		expect(() =>
			assertDriverProgram(
				program({ outputs: { endpoint: "https://fixed.example" } }),
			),
		).not.toThrow();
	});

	it("ignores a non-string output value", () => {
		expect(() =>
			assertDriverProgram(program({ outputs: { n: 7 } as never })),
		).not.toThrow();
	});
});
