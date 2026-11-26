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
		expect(isRealizablePort("queue")).toBe(false);
		expect(() => resolveEquivalence("queue")).toThrow(
			/cannot realize port queue/,
		);
	});

	it("maps each port to a distinct resource class", () => {
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
		expect(
			mergeLakebedOptions([
				{ providerId: "vercel", options: { regions: ["iad1"] } },
				{ providerId: LAKEBED_PROVIDER_TARGET, options: { region: "eu" } },
			] as never),
		).toEqual({ region: "eu" });
	});

	it("lets a later Lakebed block win a key collision", () => {
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
		const { driver } = realizeResourcePlan(plan());
		const inputs = driver.resources[0]?.inputs as Record<string, unknown>;
		expect(inputs.port).toBe("compute");
		expect(inputs.providerService).toBeTruthy();
		expect(Array.isArray(inputs.features)).toBe(true);
	});

	it("declares the outputs its resource class actually produces", () => {
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
		expect(realizeResourcePlan(plan()).driver.outputs).toEqual({
			"web.endpoint": "${resources.web.outputs.url}",
		});
		expect(
			realizeResourcePlan(plan({ name: "cache", port: "kv" })).driver.outputs,
		).toEqual({ "cache.endpoint": "${resources.cache.outputs.namespace}" });
	});

	it("emits deps as opaque provider resource ids, not references", () => {
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
		for (const port of ["compute", "kv", "objectStore", "database"]) {
			expect(() =>
				assertDriverProgram(realizeResourcePlan(plan({ port })).driver),
			).not.toThrow();
		}
	});
});

describe("realizeResourcePlans", () => {
	it("refuses an empty plan list", () => {
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
		const { driver } = realizeTrafficRoutingPlan(routing());
		expect(driver.resources[0]?.type).toBe("lakebed:traffic-route");
		expect(() => assertDriverProgram(driver)).not.toThrow();
	});

	it("sanitizes the plan id into the deployment and resource names", () => {
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
		const { driver } = realizeTrafficRoutingPlan(routing(), {
			deploymentId: "   ",
			capsule: "  ",
		});
		expect(driver.deploymentId).toBe("plan-1");
		expect(driver.capsule).toBe("capsule/web");
	});

	it("falls back when sanitizing leaves nothing", () => {
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
		const { driver } = realizeTrafficRoutingPlan(routing());
		expect(Object.keys(driver.outputs).sort()).toEqual(["binding", "routeId"]);
	});
});

describe("assertDriverProgram", () => {
	it("accepts a well-formed program", () => {
		expect(assertDriverProgram(program())).toBeTruthy();
	});

	it("refuses a wrong apiVersion, kind, or driver, naming the expected value", () => {
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
		expect(() => assertDriverProgram(program({ resources: [] }))).toThrow(
			/at least one resource/,
		);
		expect(() =>
			assertDriverProgram(program({ resources: undefined as never })),
		).toThrow(/at least one resource/);
	});

	it("refuses a resource with no name", () => {
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
		expect(() =>
			assertDriverProgram(
				program({ outputs: { endpoint: "${resources.web.outputs}" } }),
			),
		).toThrow(/invalid output reference/);
	});

	it("leaves a literal output value alone", () => {
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
