import type { EventEnvelope } from "@hobo/core";

import { hasFunctionTag } from "./json.js";

// Chained, forward-only schema evolution for event bodies (data-plane.md
// §Schema evolution). An upcaster is a pure `vN -> vN+1` transform of an event's
// `data` payload; readers apply the chain from the stored `v` up to the current
// version so old events remain replayable forever. History is never rewritten.
export type Upcaster<Input = unknown, Output = unknown> = (
	data: Input,
) => Output;

export interface UpcasterRegistry {
	// Register the `fromVersion -> fromVersion+1` transform for an event type.
	register(type: string, fromVersion: number, up: Upcaster): this;
	// Highest version reachable for `type` by chaining registered upcasters.
	latestVersion(type: string): number;
	// Apply the full chain to bring an event to its latest known version.
	upcast(event: EventEnvelope): EventEnvelope;
}

export function createUpcasterRegistry(): UpcasterRegistry {
	// type -> (fromVersion -> upcaster)
	const chains = new Map<string, Map<number, Upcaster>>();

	const registry: UpcasterRegistry = {
		register(type, fromVersion, up) {
			if (!hasFunctionTag(up)) {
				throw new TypeError("upcaster must be a function");
			}
			if (!Number.isInteger(fromVersion) || fromVersion < 1) {
				throw new TypeError("fromVersion must be a positive integer");
			}
			const chain = chains.get(type) ?? new Map<number, Upcaster>();
			if (chain.has(fromVersion)) {
				throw new Error(
					`duplicate upcaster for ${type} v${fromVersion} -> v${fromVersion + 1}`,
				);
			}
			chain.set(fromVersion, up);
			chains.set(type, chain);
			return registry;
		},

		latestVersion(type) {
			const chain = chains.get(type);
			if (!chain) return 1;
			let version = 1;
			while (chain.has(version)) version += 1;
			return version;
		},

		upcast(event) {
			const chain = chains.get(event.type);
			if (!chain) return event;
			let version = event.v;
			let data = event.data;
			while (chain.has(version)) {
				const up = chain.get(version);
				if (up === undefined) break;
				data = up(data);
				version += 1;
			}
			if (version === event.v) return event;
			return { ...event, v: version, data };
		},
	};

	return registry;
}
