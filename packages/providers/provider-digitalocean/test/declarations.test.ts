import { describe, expect, it } from "vitest";
import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
} from "../src/equivalence.js";
import type { JsonObject } from "../src/json.js";
import { DIGITALOCEAN_PROVIDER_TARGET, digitalocean } from "../src/options.js";
import {
	DIGITALOCEAN_YARD_GENERATOR_CONNECTOR_ID,
	DIGITALOCEAN_YARD_RUNTIME_ID,
	digitaloceanDefaultResolverPins,
	digitaloceanYardRuntimeRegistration,
} from "../src/yard-defaults.js";

// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
const factories = Object.entries(digitalocean.with) as [
	string,
	(options?: JsonObject) => {
		providerId: string;
		port: string;
		optionName: string;
		negotiation: string;
		options: JsonObject;
	},
][];

describe("digitalocean option blocks", () => {
	it("ships at least one option factory", () => {
		expect(factories.length).toBeGreaterThan(0);
	});

	it.each(factories)("%s stamps the provider target", (_name, factory) => {
		expect(factory().providerId).toBe(DIGITALOCEAN_PROVIDER_TARGET);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it.each(factories)("%s negotiates as a preference", (_name, factory) => {
		expect(factory().negotiation).toBe("prefer");
	});

	it.each(factories)("%s names a port and an option", (_name, factory) => {
		const block = factory();
		expect(block.port.length).toBeGreaterThan(0);
		expect(block.optionName.length).toBeGreaterThan(0);
	});

	it.each(
		factories,
	)("%s supplies defaults with no arguments", (_n, factory) => {
		expect(Object.keys(factory().options).length).toBeGreaterThan(0);
	});

	it.each(factories)("%s lets the caller override a default", (_n, factory) => {
		const [key] = Object.keys(factory().options);
		expect(factory({ [String(key)]: "overridden" }).options[String(key)]).toBe(
			"overridden",
		);
	});

	it.each(factories)("%s passes an unknown key through", (_n, factory) => {
		expect(factory({ somethingNew: 7 }).options.somethingNew).toBe(7);
	});

	it.each(
		factories,
	)("%s does not share option state between calls", (_n, f) => {
		const first = f({ leaked: true });
		const second = f();
		expect(second.options.leaked).toBeUndefined();
		expect(first.options.leaked).toBe(true);
	});

	it("gives each factory a distinct option name", () => {
		const names = factories.map(([, f]) => f().optionName);
		expect(new Set(names).size).toBe(names.length);
	});

	it("names the provider target after the provider", () => {
		expect(DIGITALOCEAN_PROVIDER_TARGET).toBe("digitalocean");
	});
});

describe("the digitalocean Yard runtime registration", () => {
	it("registers under the exact documented runtime id", () => {
		expect(digitaloceanYardRuntimeRegistration().runtimeId).toBe(
			DIGITALOCEAN_YARD_RUNTIME_ID,
		);
	});

	it("declares the provider it belongs to", () => {
		expect(digitaloceanYardRuntimeRegistration().providerId).toBe(
			"digitalocean",
		);
	});

	it("carries the schema version the reader dispatches on", () => {
		expect(digitaloceanYardRuntimeRegistration().schemaVersion).toBe(
			"hobo.yard-runtime/v1",
		);
	});

	it("names the connector Broker policy is written against", () => {
		expect(digitaloceanYardRuntimeRegistration().generatorConnectorId).toBe(
			DIGITALOCEAN_YARD_GENERATOR_CONNECTOR_ID,
		);
	});

	it("defaults to approved with a stated priority", () => {
		const registration = digitaloceanYardRuntimeRegistration();
		expect(registration.status).toBe("approved");
		expect(registration.priority).toBe(100);
	});

	it("honours a caller-supplied status", () => {
		expect(
			digitaloceanYardRuntimeRegistration({ status: "disabled" }).status,
		).toBe("disabled");
	});

	it("honours a caller-supplied priority", () => {
		expect(digitaloceanYardRuntimeRegistration({ priority: 5 }).priority).toBe(
			5,
		);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats an empty options object as no options", () => {
		expect(digitaloceanYardRuntimeRegistration({}).status).toBe("approved");
	});

	it("freezes the registration", () => {
		expect(Object.isFrozen(digitaloceanYardRuntimeRegistration())).toBe(true);
	});

	it("pins its catalog and conformance hashes by algorithm", () => {
		const registration = digitaloceanYardRuntimeRegistration();
		expect(registration.resolverCatalogHash).toMatch(/^sha256:/u);
		expect(registration.conformanceHash).toMatch(/^sha256:/u);
	});

	it("declares a non-empty supported shape", () => {
		const catalog = digitaloceanYardRuntimeRegistration().supportedCatalog;
		expect(catalog.regions.length).toBeGreaterThan(0);
		expect(catalog.capabilities.length).toBeGreaterThan(0);
	});

	it("states the permissions generation needs", () => {
		expect(
			digitaloceanYardRuntimeRegistration().requiredPermissions.length,
		).toBeGreaterThan(0);
	});

	it("points at a conformance suite rather than asserting conformance", () => {
		expect(digitaloceanYardRuntimeRegistration().conformanceRef).toContain(
			"conformance",
		);
	});
});

describe("the digitalocean default resolver pins", () => {
	it("pins at least one slot", () => {
		expect(digitaloceanDefaultResolverPins().length).toBeGreaterThan(0);
	});

	it("pins each slot exactly once", () => {
		const slots = digitaloceanDefaultResolverPins().map((pin) => pin.slot);
		expect(new Set(slots).size).toBe(slots.length);
	});

	it("names a resolver for every slot it pins", () => {
		for (const pin of digitaloceanDefaultResolverPins()) {
			expect(pin.resolverId.length).toBeGreaterThan(0);
		}
	});

	it("freezes the pin list and every pin in it", () => {
		const list = digitaloceanDefaultResolverPins();
		expect(Object.isFrozen(list)).toBe(true);
		for (const pin of list) expect(Object.isFrozen(pin)).toBe(true);
	});
});

describe("the digitalocean equivalence table", () => {
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
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
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
