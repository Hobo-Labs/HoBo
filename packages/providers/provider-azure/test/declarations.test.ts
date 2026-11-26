/**
 * The azure provider's three declaration modules: option blocks, the Yard
 * runtime registration, and the cross-cloud equivalence table.
 *
 * None of these talk to azure. They are the *claims* the rest of HoBo plans
 * against, which is precisely why they are worth pinning: a wrong value here
 * does not fail — it plans, matches, and deploys the wrong thing.
 *
 * **Option blocks must stay inert for other providers.** One Bindle targets
 * many clouds unedited, so a block that forgot its `providerId`, or that
 * negotiated `require` instead of `prefer`, would turn an additive annotation
 * into a hard constraint and fail every deploy that is not azure.
 *
 * **The runtime and connector ids are matched as exact strings.** Stations and
 * the Broker look up registrations by `runtimeId`; Broker policy is written
 * against `generatorConnectorId`. Generation is default-deny, so a renamed
 * connector id does not fail open — it silently stops matching the approval
 * that permitted generation at all, and Yards quietly stop being created.
 *
 * **An equivalence row is a promise that a product exists.** Matching answers
 * `full` for any port with a row, so a row for something azure does not sell
 * would make Matching promise a capability nothing can realize.
 */
import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
} from "../src/equivalence.js";
import { AZURE_PROVIDER_TARGET, azure } from "../src/options.js";
import {
	AZURE_YARD_GENERATOR_CONNECTOR_ID,
	AZURE_YARD_RUNTIME_ID,
	azureDefaultResolverPins,
	azureYardRuntimeRegistration,
} from "../src/yard-defaults.js";

const factories = [
	["containerApps", azure.with.containerApps],
	["postgres", azure.with.postgres],
	["blob", azure.with.blob],
	["cosmos", azure.with.cosmos],
	["serviceBus", azure.with.serviceBus],
	["redis", azure.with.redis],
] as const;

describe("azure option blocks", () => {
	it("ships at least one option factory", () => {
		// An empty namespace would type-check and silently offer nothing.
		expect(factories.length).toBeGreaterThan(0);
	});

	it.each(factories)("%s stamps the provider target", (_name, factory) => {
		// Without the target the block is unattributable, and a non-azure
		// deploy cannot tell that it should ignore it.
		expect(factory().providerId).toBe(AZURE_PROVIDER_TARGET);
	});

	it.each(factories)("%s negotiates as a preference", (_name, factory) => {
		// `prefer` is what keeps the annotation additive. `require` would make
		// one Bindle undeployable everywhere else.
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
		// The zero-argument form is the documented one; an empty block would
		// push every default onto the caller.
		expect(Object.keys(factory().options).length).toBeGreaterThan(0);
	});

	it.each(factories)("%s lets the caller override a default", (_n, factory) => {
		const [key] = Object.keys(factory().options);
		expect(factory({ [String(key)]: "overridden" }).options[String(key)]).toBe(
			"overridden",
		);
	});

	it.each(factories)("%s passes an unknown key through", (_n, factory) => {
		// The block is opaque to the core and interpreted by the resolver, so a
		// key this build does not know about must survive to reach it.
		expect(factory({ somethingNew: 7 }).options.somethingNew).toBe(7);
	});

	it.each(
		factories,
	)("%s does not share option state between calls", (_n, f) => {
		// A shared defaults object would let one Bindle's override leak into the
		// next Bindle in the same process.
		const first = f({ leaked: true });
		const second = f();
		expect(second.options.leaked).toBeUndefined();
		expect(first.options.leaked).toBe(true);
	});

	it("gives each factory a distinct option name", () => {
		// Two factories under one name are indistinguishable to the resolver
		// that dispatches on it.
		const names = factories.map(([, f]) => f().optionName);
		expect(new Set(names).size).toBe(names.length);
	});

	it("names the provider target after the provider", () => {
		expect(AZURE_PROVIDER_TARGET).toBe("azure");
	});
});

describe("the azure Yard runtime registration", () => {
	it("registers under the exact documented runtime id", () => {
		// Matched as a literal string; a change here unregisters every Yard
		// already placed on this runtime.
		expect(azureYardRuntimeRegistration().runtimeId).toBe(
			AZURE_YARD_RUNTIME_ID,
		);
	});

	it("declares the provider it belongs to", () => {
		expect(azureYardRuntimeRegistration().providerId).toBe("azure");
	});

	it("carries the schema version the reader dispatches on", () => {
		expect(azureYardRuntimeRegistration().schemaVersion).toBe(
			"hobo.yard-runtime/v1",
		);
	});

	it("names the connector Broker policy is written against", () => {
		// Generation is default-deny: a mismatch stops matching the approval
		// rather than failing open.
		expect(azureYardRuntimeRegistration().generatorConnectorId).toBe(
			AZURE_YARD_GENERATOR_CONNECTOR_ID,
		);
	});

	it("defaults to approved with a stated priority", () => {
		const registration = azureYardRuntimeRegistration();
		expect(registration.status).toBe("approved");
		expect(registration.priority).toBe(100);
	});

	it("honours a caller-supplied status", () => {
		expect(azureYardRuntimeRegistration({ status: "disabled" }).status).toBe(
			"disabled",
		);
	});

	it("honours a caller-supplied priority", () => {
		expect(azureYardRuntimeRegistration({ priority: 5 }).priority).toBe(5);
	});

	it("treats an empty options object as no options", () => {
		expect(azureYardRuntimeRegistration({}).status).toBe("approved");
	});

	it("freezes the registration", () => {
		// It is handed to the Broker and to Stations; a mutable one lets one
		// consumer reshape what the next reads.
		expect(Object.isFrozen(azureYardRuntimeRegistration())).toBe(true);
	});

	it("pins its catalog and conformance hashes by algorithm", () => {
		// A bare hex string leaves the algorithm to be guessed; the prefix is
		// what makes two implementations agree on what was hashed.
		const registration = azureYardRuntimeRegistration();
		expect(registration.resolverCatalogHash).toMatch(/^sha256:/u);
		expect(registration.conformanceHash).toMatch(/^sha256:/u);
	});

	it("declares a non-empty supported shape", () => {
		// An empty shape matches nothing, so the runtime would register and then
		// never be selected.
		const catalog = azureYardRuntimeRegistration().supportedCatalog;
		expect(catalog.regions.length).toBeGreaterThan(0);
		expect(catalog.capabilities.length).toBeGreaterThan(0);
	});

	it("states the permissions generation needs", () => {
		// The operator granting the connector has to know what they are granting.
		expect(
			azureYardRuntimeRegistration().requiredPermissions.length,
		).toBeGreaterThan(0);
	});

	it("points at a conformance suite rather than asserting conformance", () => {
		expect(azureYardRuntimeRegistration().conformanceRef).toContain(
			"conformance",
		);
	});
});

describe("the azure default resolver pins", () => {
	it("pins at least one slot", () => {
		expect(azureDefaultResolverPins().length).toBeGreaterThan(0);
	});

	it("pins each slot exactly once", () => {
		// Two pins for one slot make the winner depend on iteration order.
		const slots = azureDefaultResolverPins().map((pin) => pin.slot);
		expect(new Set(slots).size).toBe(slots.length);
	});

	it("names a resolver for every slot it pins", () => {
		for (const pin of azureDefaultResolverPins()) {
			expect(pin.resolverId.length).toBeGreaterThan(0);
		}
	});

	it("freezes the pin list and every pin in it", () => {
		const list = azureDefaultResolverPins();
		expect(Object.isFrozen(list)).toBe(true);
		for (const pin of list) expect(Object.isFrozen(pin)).toBe(true);
	});
});

describe("the azure equivalence table", () => {
	const rows = Object.entries(EQUIVALENCE_CLASSES);

	it("declares at least one equivalence class", () => {
		expect(rows.length).toBeGreaterThan(0);
	});

	it("lists exactly the ports it has rows for", () => {
		// The port list is what Matching iterates; a port without a row would
		// resolve to undefined at match time.
		expect([...INITIAL_CAPABILITY_PORTS].sort()).toEqual(
			rows.map(([port]) => port).sort(),
		);
	});

	it.each(rows)("the %s row names a port and a resource class", (_p, row) => {
		expect(row.port.length).toBeGreaterThan(0);
		expect(row.resourceClass.length).toBeGreaterThan(0);
	});

	it.each(rows)("the %s row names the product it maps to", (_p, row) => {
		// "Which azure service is this?" is the question the table exists to
		// answer for a human reading a plan.
		expect(row.providerService.length).toBeGreaterThan(0);
	});

	it.each(rows)("the %s row lists the features it claims", (_p, row) => {
		// Features are what a `require` in a Bindle is matched against; an empty
		// list matches nothing.
		expect(row.features.length).toBeGreaterThan(0);
	});

	it.each(rows)("the %s resource class is namespaced", (_p, row) => {
		// Unnamespaced classes from two providers would collide in one plan.
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
