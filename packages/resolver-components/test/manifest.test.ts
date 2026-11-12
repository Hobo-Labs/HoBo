import { CD_DEFAULTS } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import {
	componentManifestDigest,
	parseComponentManifest,
	ResolverComponentError,
} from "../src/index.js";
import { manifestJson } from "./fixtures.js";

function refusal(run: () => void): ResolverComponentError {
	try {
		run();
	} catch (error) {
		if (error instanceof ResolverComponentError) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("component manifest (parse, don't validate)", () => {
	it("parses a valid manifest into a frozen derived type", () => {
		const manifest = parseComponentManifest(manifestJson());
		expect(manifest.id).toBe("acme-static");
		expect(manifest.classes[0]?.productId).toBe("acme/site");
		expect(manifest.classes[0]?.retainedFields).toEqual(["replicas"]);
		expect(manifest.limits).toEqual({
			memoryBytes: 1_048_576,
			callTimeoutMs: 5_000,
			fuel: 100_000_000,
		});
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest.classes[0])).toBe(true);
	});

	it("defaults omitted limits to CD_DEFAULTS", () => {
		const { limits: _limits, ...rest } = manifestJson();
		const manifest = parseComponentManifest(rest);
		expect(manifest.limits).toEqual({
			memoryBytes: CD_DEFAULTS.componentMemoryBytes,
			callTimeoutMs: CD_DEFAULTS.componentCallTimeoutMs,
			fuel: CD_DEFAULTS.componentFuel,
		});
	});

	it("digests are independent of class, host and field order", () => {
		const a = parseComponentManifest(manifestJson());
		const b = parseComponentManifest(
			manifestJson({
				egress: [
					{ host: "upload.acme.test", pathPrefixes: ["/"] },
					{ host: "api.acme.test", pathPrefixes: ["/v1/"] },
				],
			}),
		);
		expect(componentManifestDigest(a)).toBe(componentManifestDigest(b));
		expect(componentManifestDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it.each([
		["wildcard host", { egress: [{ host: "*.acme.test" }] }],
		[
			"more than 32 hosts",
			{
				egress: Array.from({ length: 33 }, (_, index) => ({
					host: `h${index}.acme.test`,
				})),
			},
		],
		[
			"memory above the CD_DEFAULTS cap",
			{ limits: { memoryBytes: "134217729" } },
		],
		["timeout above the cap", { limits: { callTimeoutMs: 30_001 } }],
		["fuel above the cap", { limits: { fuel: "1000000001" } }],
		["a foreign world", { world: "wasi:http/proxy@0.2.0" }],
		["a malformed wasm digest", { wasmDigest: "sha256:xyz" }],
		[
			"a credential host outside the egress allowlist",
			{ credential: { hosts: ["evil.example"] } },
		],
		[
			"a duplicate product",
			{
				classes: [
					{ productId: "acme/site", slot: "web" },
					{ productId: "acme/site", slot: "web" },
				],
			},
		],
		[
			"an unknown slot",
			{ classes: [{ productId: "acme/site", slot: "nope" }] },
		],
		["no classes", { classes: [] }],
		["an unknown field", { surprise: true }],
		[
			"local addresses without agent mode",
			{ egress: [{ host: "files.local", localAddresses: ["10.0.0.5"] }] },
		],
		[
			"a credential-shaped retained field",
			{
				classes: [
					{ productId: "acme/site", slot: "web", retainedFields: ["apiToken"] },
				],
			},
		],
	])("refuses %s", (_label, overrides) => {
		const error = refusal(() =>
			parseComponentManifest(manifestJson(overrides)),
		);
		expect(error.componentCode).toBe("component.manifest-invalid");
		expect(error.remediation).toMatch(/manifest/u);
	});

	it("admits local addresses in agent mode only", () => {
		const manifest = parseComponentManifest(
			manifestJson({
				egress: [{ host: "bridge.local", localAddresses: ["127.0.0.1"] }],
				credential: { hosts: [] },
				modes: ["RECONCILER_MODE_RECORD_AGENT"],
			}),
		);
		expect(manifest.egress[0]?.localAddresses).toEqual(["127.0.0.1"]);
	});
});
