import { describe, expect, it } from "vitest";

import { createBlacksmithBuildMachineProvider } from "../src/build-machine-provider.js";
import { createBlacksmithCatalogEntry } from "../src/catalog-entry.js";

const CAPABILITIES_DOC = "/.well-known/capability-manifest/capabilities.json";
const COST_DOC = "/.well-known/capability-manifest/cost.json";

function buildMachineProvider() {
	return createBlacksmithBuildMachineProvider({
		client: {} as never,
		owner: "acme",
	});
}

const catalogManifest = () =>
	createBlacksmithCatalogEntry().capabilityManifest();

const surfaces = [["catalog entry", catalogManifest]] as const;

for (const [label, manifestOf] of surfaces) {
	describe(`${label} capability manifest`, () => {
		it("names the provider", () => {
			const manifest = manifestOf();
			expect(typeof manifest.providerId).toBe("string");
			expect(manifest.providerId.length).toBeGreaterThan(0);
		});

		it("publishes the capabilities document", () => {
			const published = manifestOf().published;
			expect(published).toHaveProperty(CAPABILITIES_DOC);
			expect(() =>
				JSON.parse(published[CAPABILITIES_DOC] as string),
			).not.toThrow();
		});

		it("publishes the cost document", () => {
			const published = manifestOf().published;
			expect(published).toHaveProperty(COST_DOC);
			expect(() => JSON.parse(published[COST_DOC] as string)).not.toThrow();
		});

		it("parses the published capabilities into the manifest's own field", () => {
			const manifest = manifestOf();
			expect(manifest.capabilities).toEqual(
				JSON.parse(manifest.published[CAPABILITIES_DOC] as string),
			);
		});

		it("parses the published cost into the manifest's own field", () => {
			const manifest = manifestOf();
			expect(manifest.cost).toEqual(
				JSON.parse(manifest.published[COST_DOC] as string),
			);
		});

		it("returns a copy of the published map", () => {
			const first = manifestOf();
			(first.published as Record<string, string>)["/injected"] = "x";
			expect(manifestOf().published).not.toHaveProperty("/injected");
		});

		it("is stable across calls", () => {
			expect(JSON.stringify(manifestOf())).toBe(JSON.stringify(manifestOf()));
		});
	});
}

describe("build machine provider capability manifest", () => {
	it("uses the execution-host manifest shape, not the catalog entry's", () => {
		const manifest = buildMachineProvider().capabilityManifest();
		expect(manifest.provider.id.length).toBeGreaterThan(0);
		expect(manifest.provider.kind).toBe("execution-host-provider");
		expect(manifest.provider.adapter).toBe("blacksmith");
		expect(
			(manifest as unknown as { providerId?: string }).providerId,
		).toBeUndefined();
	});

	it("honours an explicit provider id", () => {
		expect(
			createBlacksmithBuildMachineProvider({
				client: {} as never,
				owner: "acme",
				id: "blacksmith-eu",
			}).capabilityManifest().provider.id,
		).toBe("blacksmith-eu");
	});

	it("declares the build-machine interface at preview stability", () => {
		const manifest = buildMachineProvider().capabilityManifest();
		expect(manifest.capabilities[0]?.interface).toBe("hobo:build-machine/host");
		expect(manifest.capabilities[0]?.stability).toBe("preview");
	});

	it("is stable across calls", () => {
		const provider = buildMachineProvider();
		expect(JSON.stringify(provider.capabilityManifest())).toBe(
			JSON.stringify(provider.capabilityManifest()),
		);
	});

	it("agrees with the catalog entry about the default provider id", () => {
		expect(buildMachineProvider().capabilityManifest().provider.id).toBe(
			catalogManifest().providerId,
		);
	});
});
