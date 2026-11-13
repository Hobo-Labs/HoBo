// Shared test fixtures: a valid manifest document and helpers.
import type { JsonObject } from "@hobo/core";

export const WASM_DIGEST = `sha256:${"ab".repeat(32)}`;

export function manifestJson(overrides: JsonObject = {}): JsonObject {
	return {
		schema: "hobo.resolver-components.manifest/v1",
		id: "acme-static",
		version: "1.2.3",
		world: "hobo:resolver/resolver-component@0.1.0",
		wasmDigest: WASM_DIGEST,
		providerId: "acme",
		classes: [
			{
				productId: "acme/site",
				slot: "web",
				retainedFields: ["replicas"],
				observeFields: ["tls.version", "cacheTtl"],
				directives: ["forceDelete"],
			},
		],
		egress: [
			{ host: "api.acme.test", pathPrefixes: ["/v1/"] },
			{ host: "upload.acme.test", pathPrefixes: ["/"] },
		],
		credential: { hosts: ["api.acme.test"] },
		limits: { memoryBytes: "1048576", callTimeoutMs: 5000, fuel: "100000000" },
		modes: ["RECONCILER_MODE_RECORD_CONDUCTOR"],
		...overrides,
	};
}
