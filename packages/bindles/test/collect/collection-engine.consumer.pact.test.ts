import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	type CollectionContext,
	type CollectionTarget,
	collectBindleManifest,
} from "../../src/index.js";

// Consumer pact for the collection boundary: the run-to-collect engine
// (consumer HoboCollector) against the manifest-IR compile it folds through
// (provider BindleManifestCompiler). The recorded expectations pin the manifest
// hash, observed resources/binds, and the emitted event order so drift in the
// compile boundary is caught here.

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../contracts/pacts/collection-engine.pact.json",
);

interface CollectInteraction {
	description: string;
	request: {
		operation: string;
		bindleId: string;
		componentHost: { kind: string; version: string };
		resources: Array<{
			factory: string;
			name: string;
			paradigm?: string;
			bind?: string[];
		}>;
	};
	response: {
		manifestHash: string;
		resources: string[];
		binds: string[];
		events: string[];
	};
}

// Replay a pact interaction request into a run-to-collect target: the recorded
// resource list drives the define closure the engine runs in collection mode.
function targetFor(interaction: CollectInteraction): CollectionTarget {
	return {
		bindleId: interaction.request.bindleId,
		componentHost: interaction.request.componentHost,
		define(collect: CollectionContext) {
			const handles: Record<string, ReturnType<CollectionContext["data"]>> = {};
			for (const resource of interaction.request.resources) {
				if (resource.factory === "data") {
					handles[resource.name] = collect.data(
						resource.name,
						resource.paradigm ? { paradigm: resource.paradigm } : {},
					);
				} else if (resource.factory === "service") {
					const bind = Object.fromEntries(
						(resource.bind ?? []).map((id) => {
							const handle = handles[id];
							if (!handle) {
								throw new Error(`fixture binds unknown resource "${id}"`);
							}
							return [id, handle];
						}),
					);
					collect.service(resource.name, {
						image: "oci://registry.example.com/api@sha256:abc123",
						bind,
					});
				} else {
					throw new Error(`unsupported pact factory ${resource.factory}`);
				}
			}
		},
	};
}

describe("collection boundary pact", () => {
	// SAFETY: assertion required at this I/O or test boundary.
	const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: CollectInteraction[];
	};

	it("names the collector consumer and the compiler provider", () => {
		expect(pact.consumer.name).toBe("HoboCollector");
		expect(pact.provider.name).toBe("BindleManifestCompiler");
	});

	it("honours each recorded collection interaction", () => {
		for (const interaction of pact.interactions) {
			const result = collectBindleManifest(targetFor(interaction));
			expect(result.manifestHash).toBe(interaction.response.manifestHash);
			expect(result.resources).toEqual(interaction.response.resources);
			expect(result.binds).toEqual(interaction.response.binds);
			expect(result.events.map((event) => event.type)).toEqual(
				interaction.response.events,
			);
		}
	});
});
