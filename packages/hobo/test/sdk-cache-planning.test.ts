import { createHash } from "node:crypto";
import { bindle, collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import {
	lowerManifest,
	matchResource,
	type PlannerRegistry,
} from "@hobo/cloud";
import { UPSTASH_DEFINITION_ID } from "@hobo/provider-upstash";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_DEFINITIONS } from "../src/first-party-catalog.js";

describe("SDK cache selection", () => {
	it("selects a first-party backend that declares TTL and compare-and-set", () => {
		const app = bindle("cache-test", (builder) => ({
			sessions: builder.cache().allow("get", "set", "invalidate"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		const intent = lowerManifest(manifest)[0];
		const definition = FIRST_PARTY_DEFINITIONS.find(
			(item) => item.id === UPSTASH_DEFINITION_ID,
		);
		if (!intent || !definition)
			throw new Error("cache intent or first-party backend is missing");
		const digest = createHash("sha256")
			.update(
				JSON.stringify({ id: definition.id, features: definition.features }),
			)
			.digest("hex");
		const registry: PlannerRegistry = {
			catalogHash: `sha256:${digest}`,
			definitions: () => [definition],
			providers: () => [definition.providerId],
		};
		const result = matchResource(intent, registry);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.remediation.remediation);
		expect(result.definition.id).toBe(UPSTASH_DEFINITION_ID);
		expect(intent.require).toEqual(["ttl", "atomicCompareAndSet"]);
	});
});
