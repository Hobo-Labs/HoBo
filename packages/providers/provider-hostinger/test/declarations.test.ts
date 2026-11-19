import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
} from "../src/equivalence.js";
import { HOSTINGER_PROVIDER_TARGET, hostinger } from "../src/options.js";
import {
	HOSTINGER_YARD_GENERATOR_CONNECTOR_ID,
	HOSTINGER_YARD_RUNTIME_ID,
	hostingerDefaultResolverPins,
	hostingerYardRuntimeRegistration,
} from "../src/yard-defaults.js";

const factories = [
	["vps", hostinger.with.vps],
	["webHosting", hostinger.with.webHosting],
	["mysql", hostinger.with.mysql],
] as const;

describe("hostinger option blocks", () => {
	it("ships at least one option factory", () => {
		expect(factories.length).toBeGreaterThan(0);
	});

	it.each(factories)("%s stamps the provider target", (_name, factory) => {
		expect(factory().providerId).toBe(HOSTINGER_PROVIDER_TARGET);
	});

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
		expect(HOSTINGER_PROVIDER_TARGET).toBe("hostinger");
	});
});

describe("the hostinger Yard runtime registration", () => {
	it("registers under the exact documented runtime id", () => {
		expect(hostingerYardRuntimeRegistration().runtimeId).toBe(
			HOSTINGER_YARD_RUNTIME_ID,
		);
	});

	it("declares the provider it belongs to", () => {
		expect(hostingerYardRuntimeRegistration().providerId).toBe("hostinger");
	});

	it("carries the schema version the reader dispatches on", () => {
		expect(hostingerYardRuntimeRegistration().schemaVersion).toBe(
			"hobo.yard-runtime/v1",
		);
	});

	it("names the connector Broker policy is written against", () => {
		expect(hostingerYardRuntimeRegistration().generatorConnectorId).toBe(
			HOSTINGER_YARD_GENERATOR_CONNECTOR_ID,
		);
	});

	it("defaults to approved with a stated priority", () => {
		const registration = hostingerYardRuntimeRegistration();
		expect(registration.status).toBe("approved");
		expect(registration.priority).toBe(100);
	});

	it("honours a caller-supplied status", () => {
		expect(
			hostingerYardRuntimeRegistration({ status: "disabled" }).status,
		).toBe("disabled");
	});

	it("honours a caller-supplied priority", () => {
		expect(hostingerYardRuntimeRegistration({ priority: 5 }).priority).toBe(5);
	});

	it("treats an empty options object as no options", () => {
		expect(hostingerYardRuntimeRegistration({}).status).toBe("approved");
	});

	it("freezes the registration", () => {
		expect(Object.isFrozen(hostingerYardRuntimeRegistration())).toBe(true);
	});

	it("pins its catalog and conformance hashes by algorithm", () => {
		const registration = hostingerYardRuntimeRegistration();
		expect(registration.resolverCatalogHash).toMatch(/^sha256:/u);
		expect(registration.conformanceHash).toMatch(/^sha256:/u);
	});

	it("declares a non-empty supported catalog", () => {
		const catalog = hostingerYardRuntimeRegistration().supportedCatalog;
		expect(catalog.regions.length).toBeGreaterThan(0);
		expect(catalog.capabilities.length).toBeGreaterThan(0);
	});

	it("states the permissions generation needs", () => {
		expect(
			hostingerYardRuntimeRegistration().requiredPermissions.length,
		).toBeGreaterThan(0);
	});

	it("points at a conformance suite rather than asserting conformance", () => {
		expect(hostingerYardRuntimeRegistration().conformanceRef).toContain(
			"conformance",
		);
	});
});

describe("the hostinger default resolver pins", () => {
	it("pins at least one slot", () => {
		expect(hostingerDefaultResolverPins().length).toBeGreaterThan(0);
	});

	it("pins each slot exactly once", () => {
		const slots = hostingerDefaultResolverPins().map((pin) => pin.slot);
		expect(new Set(slots).size).toBe(slots.length);
	});

	it("names a resolver for every slot it pins", () => {
		for (const pin of hostingerDefaultResolverPins()) {
			expect(pin.resolverId.length).toBeGreaterThan(0);
		}
	});

	it("freezes the pin list and every pin in it", () => {
		const list = hostingerDefaultResolverPins();
		expect(Object.isFrozen(list)).toBe(true);
		for (const pin of list) expect(Object.isFrozen(pin)).toBe(true);
	});
});

describe("the hostinger equivalence table", () => {
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

	it.each(INITIAL_CAPABILITY_PORTS)("looks the %s row up by port", (port) => {
		expect(equivalenceForPort(port)).toBe(EQUIVALENCE_CLASSES[port]);
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
