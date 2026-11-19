import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
} from "../src/equivalence.js";
import { kubernetes, PROVIDER_TARGET } from "../src/options.js";
import {
	KUBERNETES_YARD_GENERATOR_CONNECTOR_ID,
	KUBERNETES_YARD_RUNTIME_ID,
	kubernetesDefaultResolverPins,
	kubernetesYardRuntimeRegistration,
} from "../src/yard-defaults.js";

describe("kubernetes option blocks", () => {
	const placement = {
		namespace: "apps",
		name: "checkout",
		image: "registry.example.com/checkout:1.2.3",
	};

	it("stamps the provider target on both blocks", () => {
		expect(kubernetes.with.deployment().providerId).toBe(PROVIDER_TARGET);
		expect(kubernetes.with.workload(placement).providerId).toBe(
			PROVIDER_TARGET,
		);
	});

	it("names the provider target after the provider", () => {
		expect(PROVIDER_TARGET).toBe("kubernetes");
	});

	it("puts both blocks on the compute port under distinct names", () => {
		expect(kubernetes.with.deployment().port).toBe("compute");
		expect(kubernetes.with.workload(placement).port).toBe("compute");
		expect(kubernetes.with.deployment().optionName).not.toBe(
			kubernetes.with.workload(placement).optionName,
		);
	});

	it("keeps a plain deployment an inert preference", () => {
		const block = kubernetes.with.deployment();
		expect(block.negotiation).toBe("prefer");
		expect(block.options.simulation).toBe(true);
	});

	it("lets a caller turn simulation off", () => {
		expect(
			kubernetes.with.deployment({ simulation: false }).options.simulation,
		).toBe(false);
	});

	it("passes an unknown deployment key through to the resolver", () => {
		expect(
			kubernetes.with.deployment({ somethingNew: 7 }).options.somethingNew,
		).toBe(7);
	});

	it("does not share deployment option state between calls", () => {
		kubernetes.with.deployment({ leaked: true });
		expect(kubernetes.with.deployment().options.leaked).toBeUndefined();
	});

	it("makes a real workload a requirement, not a preference", () => {
		expect(kubernetes.with.workload(placement).negotiation).toBe("require");
	});

	it("parses the placement rather than carrying it unchecked", () => {
		const parsed = kubernetes.with.workload(placement).placement;
		expect(parsed.workloadName).toBe("checkout");
		expect(parsed.imageRef).toBe("registry.example.com/checkout:1.2.3");
	});

	it("refuses a name that is not an RFC 1123 label", () => {
		expect(() =>
			kubernetes.with.workload({ ...placement, name: "Check_Out" }),
		).toThrow(/RFC 1123/u);
	});

	it("refuses a placement that is not an object at all", () => {
		expect(() => kubernetes.with.workload(undefined as never)).toThrow(
			/placement must be an object/u,
		);
	});

	it("keeps the caller keys on the workload block alongside the placement", () => {
		expect(kubernetes.with.workload(placement).options.namespace).toBe("apps");
	});

	it("fills the resource requests the caller did not state", () => {
		const parsed = kubernetes.with.workload(placement).placement;
		expect(parsed.requests.cpuMillicores).toBeGreaterThan(0);
		expect(parsed.limits.memoryBytes).toBeGreaterThan(0);
		expect(parsed.replicas).toBeGreaterThan(0);
	});
});

describe("the kubernetes Yard runtime registration", () => {
	it("registers under the exact documented runtime id", () => {
		expect(kubernetesYardRuntimeRegistration().runtimeId).toBe(
			KUBERNETES_YARD_RUNTIME_ID,
		);
	});

	it("declares the provider it belongs to", () => {
		expect(kubernetesYardRuntimeRegistration().providerId).toBe("kubernetes");
	});

	it("carries the schema version the reader dispatches on", () => {
		expect(kubernetesYardRuntimeRegistration().schemaVersion).toBe(
			"hobo.yard-runtime/v1",
		);
	});

	it("names the connector Broker policy is written against", () => {
		expect(kubernetesYardRuntimeRegistration().generatorConnectorId).toBe(
			KUBERNETES_YARD_GENERATOR_CONNECTOR_ID,
		);
	});

	it("defaults to approved with a stated priority", () => {
		const registration = kubernetesYardRuntimeRegistration();
		expect(registration.status).toBe("approved");
		expect(registration.priority).toBe(100);
	});

	it("honours a caller-supplied status", () => {
		expect(
			kubernetesYardRuntimeRegistration({ status: "disabled" }).status,
		).toBe("disabled");
	});

	it("honours a caller-supplied priority", () => {
		expect(kubernetesYardRuntimeRegistration({ priority: 5 }).priority).toBe(5);
	});

	it("treats an empty options object as no options", () => {
		expect(kubernetesYardRuntimeRegistration({}).status).toBe("approved");
	});

	it("freezes the registration", () => {
		expect(Object.isFrozen(kubernetesYardRuntimeRegistration())).toBe(true);
	});

	it("pins its catalog and conformance hashes by algorithm", () => {
		const registration = kubernetesYardRuntimeRegistration();
		expect(registration.resolverCatalogHash).toMatch(/^sha256:/u);
		expect(registration.conformanceHash).toMatch(/^sha256:/u);
	});

	it("declares a non-empty supported shape", () => {
		const supported = kubernetesYardRuntimeRegistration().supportedKind;
		expect(supported.regions.length).toBeGreaterThan(0);
		expect(supported.capabilities.length).toBeGreaterThan(0);
	});

	it("states the permissions generation needs", () => {
		expect(
			kubernetesYardRuntimeRegistration().requiredPermissions.length,
		).toBeGreaterThan(0);
	});

	it("points at a conformance suite rather than asserting conformance", () => {
		expect(kubernetesYardRuntimeRegistration().conformanceRef).toContain(
			"conformance",
		);
	});
});

describe("the kubernetes default resolver pins", () => {
	it("pins at least one slot", () => {
		expect(kubernetesDefaultResolverPins().length).toBeGreaterThan(0);
	});

	it("pins each slot exactly once", () => {
		const slots = kubernetesDefaultResolverPins().map((pin) => pin.slot);
		expect(new Set(slots).size).toBe(slots.length);
	});

	it("names a resolver for every slot it pins", () => {
		for (const pin of kubernetesDefaultResolverPins()) {
			expect(pin.resolverId.length).toBeGreaterThan(0);
		}
	});

	it("freezes the pin list and every pin in it", () => {
		const list = kubernetesDefaultResolverPins();
		expect(Object.isFrozen(list)).toBe(true);
		for (const pin of list) expect(Object.isFrozen(pin)).toBe(true);
	});
});

describe("the kubernetes equivalence table", () => {
	const rows = Object.entries(EQUIVALENCE_CLASSES);

	it("declares at least one equivalence class", () => {
		expect(rows.length).toBeGreaterThan(0);
	});

	it("lists exactly the ports it has rows for", () => {
		expect([...INITIAL_CAPABILITY_PORTS].sort()).toEqual(
			rows.map(([port]) => port).sort(),
		);
	});

	it.each(rows)("the %s row names a port and a resource class", (_p, row) => {
		expect(row.port.length).toBeGreaterThan(0);
		expect(row.resourceClass.length).toBeGreaterThan(0);
	});

	it.each(rows)("the %s row names the product it maps to", (_p, row) => {
		expect(row.providerService.length).toBeGreaterThan(0);
	});

	it.each(rows)("the %s row lists the features it claims", (_p, row) => {
		expect(row.features.length).toBeGreaterThan(0);
	});

	it.each(rows)("the %s resource class is namespaced", (_p, row) => {
		expect(row.resourceClass).toContain(":");
	});

	it.each(rows)("looks the %s row up by port", (port, row) => {
		expect(equivalenceForPort(port as never)).toBe(row);
	});

	it("gives each row a distinct resource class", () => {
		const classes = rows.map(([, row]) => row.resourceClass);
		expect(new Set(classes).size).toBe(classes.length);
	});

	it("freezes the table", () => {
		expect(Object.isFrozen(EQUIVALENCE_CLASSES)).toBe(true);
		expect(Object.isFrozen(INITIAL_CAPABILITY_PORTS)).toBe(true);
	});
});
