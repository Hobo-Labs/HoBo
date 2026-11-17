import { describe, expect, it } from "vitest";

import { kubernetesYardSpec } from "../src/default-yard.js";
import { EQUIVALENCE_CLASSES } from "../src/equivalence.js";
import { assertLocalIacProgram } from "../src/iac-program.js";
import {
	createKubernetesProvider,
	kubernetesDriverProgram,
} from "../src/provider.js";
import {
	isRealizablePort,
	mergeKubernetesOptions,
	realizeResourcePlan,
	realizeResourcePlans,
	resolveEquivalence,
} from "../src/realize.js";
import type { ResourcePlan } from "../src/types.js";

describe("the equivalence table's honest count", () => {
	it("claims exactly one class: compute", () => {
		expect(Object.keys(EQUIVALENCE_CLASSES)).toEqual(["web/service"]);
		expect(EQUIVALENCE_CLASSES["web/service"].port).toBe("compute");
	});

	it("realizes compute and refuses every other port", () => {
		expect(isRealizablePort("compute")).toBe(true);
		for (const port of ["database", "kv", "queue", "blob", "cache"]) {
			expect(isRealizablePort(port)).toBe(false);
			expect(() => resolveEquivalence(port)).toThrow(
				new RegExp(`cannot realize port ${port}`, "u"),
			);
		}
	});

	it("offers a Yard catalog wider than the equivalence table, deliberately", () => {
		expect(kubernetesYardSpec().bindings.length).toBeGreaterThan(
			Object.keys(EQUIVALENCE_CLASSES).length,
		);
	});
});

const PLAN = {
	name: "api",
	port: "compute",
	provider: "kubernetes",
} satisfies ResourcePlan;

describe("realize", () => {
	it("merges Kubernetes option blocks in declaration order", () => {
		expect(
			mergeKubernetesOptions([
				{ providerId: "kubernetes", options: { replicas: 1, ns: "default" } },
				{ providerId: "kubernetes", options: { replicas: 3 } },
			]),
		).toEqual({ replicas: 3, ns: "default" });
	});

	it("drops blocks belonging to another provider", () => {
		expect(
			mergeKubernetesOptions([
				{ providerId: "aws", options: { instanceType: "t3.micro" } },
				{ providerId: "kubernetes", options: { replicas: 2 } },
			]),
		).toEqual({ replicas: 2 });
	});

	it("merges an absent option list to an empty object", () => {
		expect(mergeKubernetesOptions()).toEqual({});
		expect(mergeKubernetesOptions([])).toEqual({});
	});

	it("realizes a plan into a program that passes its own check", () => {
		const { iac } = realizeResourcePlan(PLAN);
		expect(() => assertLocalIacProgram(iac)).not.toThrow();
		expect(iac.resources[0]?.type).toBe("kubernetes:deployment");
	});

	it("omits the region when the plan states none", () => {
		expect(
			Object.hasOwn(
				realizeResourcePlan(PLAN).iac.resources[0]?.inputs ?? {},
				"region",
			),
		).toBe(false);
	});

	it("emits no build spec for a plan that builds nothing", () => {
		expect(realizeResourcePlan(PLAN).build).toBeUndefined();
	});

	it("emits a build spec naming the artifact when the plan builds one", () => {
		const { build } = realizeResourcePlan({
			...PLAN,
			build: { artifactId: "a-1", source: "./src", target: "wasm32-wasi" },
		});
		expect(build?.artifacts[0]?.id).toBe("a-1");
	});

	it("realizes several plans into one program whose bind references resolve", () => {
		const { iac } = realizeResourcePlans([
			{ ...PLAN, name: "web" },
			{ ...PLAN, name: "api", deps: ["web"] },
		]);
		expect(iac.resources).toHaveLength(2);
		expect(() => assertLocalIacProgram(iac)).not.toThrow();
	});

	it("refuses an empty deployment plan", () => {
		expect(() => realizeResourcePlans([])).toThrow(/cannot realize an empty/u);
	});

	it("derives the stack name from the deployment id", () => {
		const { iac } = realizeResourcePlans([PLAN], { deploymentId: "d-9" });
		expect(iac.stack).toBe("kubernetes/d-9");
	});
});

describe("provider surface", () => {
	const provider = createKubernetesProvider();

	it("declares one capability, matching the equivalence table", () => {
		expect(provider.capabilities).toHaveLength(1);
		expect(provider.capabilities[0]?.port).toBe("compute");
	});

	it("matches fully when the requested features are all offered", () => {
		expect(
			provider.capabilities[0]?.satisfies({
				port: "compute",
				features: ["container", "http"],
			}),
		).toEqual({ kind: "full" });
	});

	it("matches fully when no features are requested", () => {
		expect(provider.capabilities[0]?.satisfies({ port: "compute" })).toEqual({
			kind: "full",
		});
	});

	it("reports a partial match naming exactly what is missing", () => {
		expect(
			provider.capabilities[0]?.satisfies({
				port: "compute",
				features: ["http", "gpu"],
			}),
		).toEqual({ kind: "partial", missing: ["gpu"] });
	});

	it("reports no match for a port it does not serve", () => {
		expect(provider.capabilities[0]?.satisfies({ port: "database" })).toEqual({
			kind: "none",
		});
	});

	it("parses each published manifest document into its own field", () => {
		const manifest = provider.capabilityManifest();
		for (const [document, parsed] of [
			["capabilities.json", manifest.capabilities],
			["auth.json", manifest.auth],
			["cost.json", manifest.cost],
		] as const) {
			expect(parsed).toEqual(
				JSON.parse(
					String(
						manifest.published[`/.well-known/capability-manifest/${document}`],
					),
				),
			);
		}
	});

	it("builds a client for the compute port carrying its outputs", () => {
		const client = provider.client("compute", { clusterIP: "10.0.0.1" });
		expect(client.resourceClass).toBe("kubernetes:deployment");
		expect(client.providerService).toBe("Kubernetes Deployment");
		expect(client.bindings).toEqual({ clusterIP: "10.0.0.1" });
	});

	it("refuses a client for a port it has none for, naming the port", () => {
		expect(() => provider.client("database", {})).toThrow(
			/no client for port database/u,
		);
	});

	it("emits a driver program naming the mapped resource class", () => {
		const driver = kubernetesDriverProgram(PLAN);
		expect(driver.apiVersion).toBe("hobo.driver-program/v1");
		expect(driver.driver).toBe("kubernetes-deploy");
		expect(driver.resources[0]?.type).toBe("kubernetes:deployment");
	});

	it("refuses to emit a driver program for an unrealizable port", () => {
		expect(() =>
			kubernetesDriverProgram({ ...PLAN, name: "db", port: "database" }),
		).toThrow(/cannot realize port database/u);
	});
});

describe("yard spec rows", () => {
	it("names kubernetes as the provider and carries regions", () => {
		expect(kubernetesYardSpec().provider).toBe("kubernetes");
		expect(kubernetesYardSpec().regions.length).toBeGreaterThan(0);
	});

	it("honours a region override and copies the caller's array", () => {
		const regions = ["eu-west"];
		const spec = kubernetesYardSpec({ regions });
		regions.push("us-east");
		expect(spec.regions).toEqual(["eu-west"]);
	});

	it("sorts rows by profile, then product, then connectivity", () => {
		const rows = kubernetesYardSpec().bindings;
		const key = (row: (typeof rows)[number]) =>
			`${row.profile} ${row.productId ?? ""} ${row.connectivityId ?? ""}`;
		expect(rows.map(key)).toEqual(rows.map(key).sort());
	});

	it("freezes the spec and every row", () => {
		const spec = kubernetesYardSpec();
		expect(Object.isFrozen(spec)).toBe(true);
		for (const row of spec.bindings) expect(Object.isFrozen(row)).toBe(true);
	});

	it("is stable across calls", () => {
		expect(JSON.stringify(kubernetesYardSpec())).toBe(
			JSON.stringify(kubernetesYardSpec()),
		);
	});
});
