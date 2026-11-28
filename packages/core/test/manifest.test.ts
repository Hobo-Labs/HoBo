import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CORE_SCHEMA_VERSION,
	ManifestParseError,
	parseCapabilityManifestBundle,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function validManifestBundle() {
	const bundleDir = join(fixturesDir, "valid-manifest-bundle");
	return {
		index: JSON.parse(readFileSync(join(bundleDir, "index.json"), "utf8")),
		capabilities: JSON.parse(
			readFileSync(join(bundleDir, "capabilities.json"), "utf8"),
		),
		auth: JSON.parse(readFileSync(join(bundleDir, "auth.json"), "utf8")),
		cost: JSON.parse(readFileSync(join(bundleDir, "cost.json"), "utf8")),
	};
}

describe("CapabilityManifestBundle", () => {
	it("accepts a valid four-file bundle and deep-freezes it", () => {
		const manifest = parseCapabilityManifestBundle(validManifestBundle(), {
			trustedIssuer: "https://acme-cloud.example.com",
			trustedOidcDiscoveryHost: "yard.example.com",
		});

		expect(manifest.index.schemaVersion).toBe(CORE_SCHEMA_VERSION);
		expect(manifest.auth.flows[0]?.type).toBe("oidc-federation");
		expect(Object.isFrozen(manifest)).toBe(true);
	});

	it("rejects issuer mismatch with ManifestParseError", () => {
		const raw = JSON.parse(
			readFileSync(join(fixturesDir, "malformed-manifest-issuer.json"), "utf8"),
		);

		expect(() => parseCapabilityManifestBundle(raw)).toThrow(
			ManifestParseError,
		);
		try {
			parseCapabilityManifestBundle(raw);
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as ManifestParseError).path).toBe("auth.issuer");
		}
	});

	it("rejects unknown properties in closed shapes", () => {
		const bundle = validManifestBundle();
		// SAFETY: assertion required at this I/O or test boundary.
		(bundle.index as JsonObject).extra = true;

		expect(() => parseCapabilityManifestBundle(bundle)).toThrow(
			ManifestParseError,
		);
	});

	it("rejects auth flows out of canonical order after duplicate type check", () => {
		const bundle = validManifestBundle();
		bundle.auth.flows = [
			{ type: "api-key", header: "X-Api-Key", rotation: "manual" },
			{
				type: "oidc-federation",
				audience: "hobo",
				exchange: "sts:AssumeRoleWithWebIdentity",
				trust: {
					oidcDiscovery:
						"https://yard.example.com/.well-known/openid-configuration",
				},
			},
		];

		const manifest = parseCapabilityManifestBundle(bundle);
		expect(manifest.auth.flows[0]?.type).toBe("oidc-federation");
		expect(manifest.auth.flows[1]?.type).toBe("api-key");
	});

	it("rejects api-key flow missing header", () => {
		const bundle = validManifestBundle();
		bundle.auth.flows = [{ type: "api-key", rotation: "manual" }];

		expect(() => parseCapabilityManifestBundle(bundle)).toThrow(
			ManifestParseError,
		);
	});
});
