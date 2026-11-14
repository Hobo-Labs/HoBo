/**
 * The local definitions, held to what `@hobo/runtime-local` actually runs.
 *
 * The seed in `@hobo/yards` is the denominator, but an adapter package may
 * not depend on `@hobo/yards` (package-boundary rule
 * `adapter-imports-non-core`), so the seed-mapping assertions live with
 * the composition that may import both sides:
 * `packages/hobo/test/first-party-catalog.test.ts`. This file pins the
 * package-local invariants those assertions rely on.
 */
import { describe, expect, it } from "vitest";

import {
	deterministicLocalResourceName,
	LOCAL_DEFINITIONS,
	LOCAL_ENGINE_GAPS,
	LOCAL_PROVIDER_ID,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
} from "../src/index.js";

describe("the declared local products", () => {
	it("uses the local provider id the seed stamps", () => {
		// The equality with `@hobo/yards`' LOCALHOST_PROVIDER_ID is asserted
		// in the composition-side catalog test.
		expect(LOCAL_PROVIDER_ID).toBe("local");
		for (const definition of LOCAL_DEFINITIONS) {
			expect(definition.providerId).toBe("local");
		}
	});

	it("keeps claimed products and named gaps disjoint, gaps explained", () => {
		const claimed = LOCAL_DEFINITIONS.map(
			(definition) => definition.semantics.productId,
		);
		const gaps = LOCAL_ENGINE_GAPS.map((gap) => gap.seedProductId);
		expect(new Set(claimed).size).toBe(claimed.length);
		expect(new Set(gaps).size).toBe(gaps.length);
		for (const productId of gaps) {
			expect(claimed).not.toContain(productId);
		}
		for (const gap of LOCAL_ENGINE_GAPS) {
			expect(gap.reason.length).toBeGreaterThan(20);
			expect(gap.missingEngine).toBeTruthy();
		}
	});

	it("parses as a vNext semantics block", () => {
		// The same refusal rules as `parseResourceDefinitionVNext` in
		// `@hobo/cloud`, restated here because a provider package must not
		// depend on the catalog that consumes it.
		for (const definition of LOCAL_DEFINITIONS) {
			const semantics = definition.semantics;
			expect(semantics.schemaVersion).toBe(RESOURCE_DEFINITION_VNEXT_SCHEMA);
			expect(semantics.implementsProfiles.length).toBeGreaterThan(0);
			expect(semantics.executorRef.length).toBeGreaterThan(0);
			expect(Number.isInteger(semantics.claimActionCount)).toBe(true);
			expect(semantics.claimActionCount).toBeGreaterThanOrEqual(0);
			expect(semantics.sponsorExposureMinorUnits).toBe(0);
			expect(semantics.trustEvidenceRef).toBeTruthy();
			expect(semantics.sourceEvidenceRefs.length).toBeGreaterThan(0);
		}
	});

	it("fails closed by default: no fabricated attestation", () => {
		// Station-local evidence must be supplied by the composition that
		// verified it. The shipped constants do not attest themselves.
		for (const definition of LOCAL_DEFINITIONS) {
			expect(definition.semantics.evidenceSignatureValid).toBe(false);
			for (const implementation of definition.semantics.implementsProfiles) {
				expect(implementation.conformance).toBe("unknown");
				expect(implementation.conformanceRef).toContain("engine-traced");
			}
		}
	});

	it("claims only runtime models the runtime-local engines serve", () => {
		// The component host runs wasm; the in-process host runs supplied
		// fetch handlers (no wasm), and queue and sqlite have no workload
		// runtime. None may claim oci / vm_iaas / paas / serverless_faas.
		const byProduct = Object.fromEntries(
			LOCAL_DEFINITIONS.map((d) => [
				d.semantics.productId,
				d.semantics.runtimeModels,
			]),
		);
		expect(byProduct).toEqual({
			"local:node-http-server": ["wasm"],
			"local:in-process-worker": [],
			"local:in-memory-queue": [],
			"local:sqlite-file": [],
		});
		for (const definition of LOCAL_DEFINITIONS) {
			for (const model of definition.semantics.runtimeModels) {
				expect(["oci", "vm_iaas", "paas", "serverless_faas"]).not.toContain(
					model,
				);
			}
		}
	});

	it("claims no revocation until a down loop exists", () => {
		for (const definition of LOCAL_DEFINITIONS) {
			expect(definition.semantics.supportsRevocation).toBe(false);
		}
	});

	it("is frozen and sorted by id", () => {
		expect(Object.isFrozen(LOCAL_DEFINITIONS)).toBe(true);
		const ids = LOCAL_DEFINITIONS.map((definition) => definition.id);
		expect([...ids].sort()).toEqual(ids);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("deterministic physical naming", () => {
	it("is a pure function of product and logical id", () => {
		const first = deterministicLocalResourceName(
			"local:in-memory-queue",
			"jobs",
		);
		const again = deterministicLocalResourceName(
			"local:in-memory-queue",
			"jobs",
		);
		expect(first).toBe(again);
		expect(first).toBe("hobo-local--in-memory-queue--jobs");
	});

	it("refuses an empty or path-shaped logical id", () => {
		expect(() =>
			deterministicLocalResourceName("local:in-memory-queue", ""),
		).toThrow(TypeError);
		expect(() =>
			deterministicLocalResourceName("local:in-memory-queue", "../escape"),
		).toThrow(TypeError);
		expect(() => deterministicLocalResourceName("", "jobs")).toThrow(TypeError);
	});
});
