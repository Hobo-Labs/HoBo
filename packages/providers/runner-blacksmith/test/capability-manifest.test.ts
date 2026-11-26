/**
 * The published capability manifests on both Blacksmith surfaces.
 *
 * A capability manifest is what a cost-aware dispatcher ranks a runner on. Two
 * properties matter and neither is obvious from reading the getter:
 *
 * The **published documents and the parsed fields must agree.** The manifest
 * carries both the raw `/.well-known/…` JSON strings and the parsed objects
 * derived from them, so a consumer can read whichever it prefers. If those two
 * ever disagreed, two readers of the same manifest would draw opposite
 * conclusions about what this runner offers and what it costs — and nothing in
 * the shape would flag the contradiction.
 *
 * The **published map must be a copy.** It is read on every dispatch decision;
 * a caller that mutated the returned object would change what every later
 * manifest reports, for the whole process.
 */
import { describe, expect, it } from "vitest";

import { createBlacksmithBuildMachineProvider } from "../src/build-machine-provider.js";
import { createBlacksmithCatalogEntry } from "../src/catalog-entry.js";

const CAPABILITIES_DOC = "/.well-known/capability-manifest/capabilities.json";
const COST_DOC = "/.well-known/capability-manifest/cost.json";

/** The build-machine provider needs a client and an owner to be constructed. */
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
			// The id is what a dispatch receipt attributes the choice to. A
			// manifest that named nobody would make the record unattributable.
			const manifest = manifestOf();
			expect(typeof manifest.providerId).toBe("string");
			expect(manifest.providerId.length).toBeGreaterThan(0);
		});

		it("publishes the capabilities document", () => {
			// Its absence would make the runner unrankable while still appearing
			// available — the worst of both, since Matching would consider it and
			// then have nothing to compare.
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
			// The agreement property. Two readers of one manifest must not be able
			// to reach different conclusions about what this runner offers.
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
			// Read on every dispatch decision. A caller that mutated the returned
			// object would change what every later manifest reports for the whole
			// process — a corruption with no failure at the point it happened.
			const first = manifestOf();
			(first.published as Record<string, string>)["/injected"] = "x";
			expect(manifestOf().published).not.toHaveProperty("/injected");
		});

		it("is stable across calls", () => {
			// Two manifests from the same provider must describe the same thing,
			// or a dispatcher that re-read one mid-run would see the runner change
			// underneath it.
			expect(JSON.stringify(manifestOf())).toBe(JSON.stringify(manifestOf()));
		});
	});
}

describe("build machine provider capability manifest", () => {
	it("uses the execution-host manifest shape, not the catalog entry's", () => {
		// Worth pinning because the two surfaces of one runner publish
		// *different* manifest shapes. The catalog entry publishes
		// `/.well-known/…` documents with a flat `providerId`; the build-machine
		// provider returns an execution-host manifest whose identity lives under
		// `provider.id` alongside a category and an adapter name.
		//
		// A consumer that assumed one shape and got the other reads `undefined`
		// rather than failing, so this is exactly the kind of divergence that
		// surfaces as a blank field in a dispatch receipt rather than as an
		// error. Recorded so nobody "fixes" one to match the other without
		// knowing both are consumed.
		const manifest = buildMachineProvider().capabilityManifest();
		expect(manifest.provider.id.length).toBeGreaterThan(0);
		expect(manifest.provider.kind).toBe("execution-host-provider");
		expect(manifest.provider.adapter).toBe("blacksmith");
		expect(
			(manifest as unknown as { providerId?: string }).providerId,
		).toBeUndefined();
	});

	it("honours an explicit provider id", () => {
		// So two Blacksmith providers configured differently — a different
		// workflow or runner label — stay distinguishable in a receipt rather
		// than both reporting the default.
		expect(
			createBlacksmithBuildMachineProvider({
				client: {} as never,
				owner: "acme",
				id: "blacksmith-eu",
			}).capabilityManifest().provider.id,
		).toBe("blacksmith-eu");
	});

	it("declares the build-machine interface at preview stability", () => {
		// Matching binds on the interface string, and `preview` is a promise
		// about compatibility. Claiming `stable` would tell integrators the
		// interface will not move when it still might.
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
		// Different shapes, same identity. Different ids would make a cost
		// comparison and a dispatch receipt disagree about which runner was
		// chosen.
		expect(buildMachineProvider().capabilityManifest().provider.id).toBe(
			catalogManifest().providerId,
		);
	});
});
