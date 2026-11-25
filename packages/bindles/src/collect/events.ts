import { createHash } from "node:crypto";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../json.js";

import type { ManifestHash } from "../manifest/index.js";

// The two facts run-to-collect appends per collection run. `bindle.ResourcesCollected`
// (seq 1) records what the components declared while running in collection mode;
// `bindle.ManifestProduced` (seq 2) records the deterministic manifest IR hash an
// actor folded from them. Ids are content-addressed so two runs of the same
// Bindle emit byte-identical events (determinism gate).

export const COLLECTION_EVENT_SOURCE = "hobo.collector" as const;

export type CollectionEventType =
	| "bindle.ResourcesCollected"
	| "bindle.ManifestProduced";

export interface ResourcesCollectedData {
	readonly bindleId: string;
	readonly resources: readonly string[];
	readonly binds: readonly string[];
}

export interface ManifestProducedData {
	readonly bindleId: string;
	readonly manifestHash: ManifestHash;
}

export interface ResourcesCollectedEvent {
	readonly id: string;
	readonly type: "bindle.ResourcesCollected";
	readonly seq: 1;
	readonly source: typeof COLLECTION_EVENT_SOURCE;
	readonly data: ResourcesCollectedData;
}

export interface ManifestProducedEvent {
	readonly id: string;
	readonly type: "bindle.ManifestProduced";
	readonly seq: 2;
	readonly source: typeof COLLECTION_EVENT_SOURCE;
	readonly data: ManifestProducedData;
}

export type CollectionEvent = ResourcesCollectedEvent | ManifestProducedEvent;

function stableDigest<T>(value: T): string {
	return createHash("sha256")
		.update(JSON.stringify(sortKeys(cloneAsJson(value))))
		.digest("hex");
}

export function createCollectionEvents(input: {
	readonly bindleId: string;
	readonly manifestHash: ManifestHash;
	readonly resources: readonly string[];
	readonly binds: readonly string[];
}): readonly CollectionEvent[] {
	const collected: ResourcesCollectedData = {
		bindleId: input.bindleId,
		resources: [...input.resources],
		binds: [...input.binds],
	};
	const produced: ManifestProducedData = {
		bindleId: input.bindleId,
		manifestHash: input.manifestHash,
	};

	return Object.freeze([
		Object.freeze({
			id: `evt-${stableDigest({ type: "bindle.ResourcesCollected", data: collected }).slice(0, 12)}`,
			type: "bindle.ResourcesCollected",
			seq: 1,
			source: COLLECTION_EVENT_SOURCE,
			data: Object.freeze(collected),
		} satisfies ResourcesCollectedEvent),
		Object.freeze({
			id: `evt-${stableDigest({ type: "bindle.ManifestProduced", data: produced }).slice(0, 12)}`,
			type: "bindle.ManifestProduced",
			seq: 2,
			source: COLLECTION_EVENT_SOURCE,
			data: Object.freeze(produced),
		} satisfies ManifestProducedEvent),
	]);
}

function sortKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (!value || !isJsonObject(value)) {
		return value;
	}
	return Object.fromEntries(
		// SAFETY: assertion required at this I/O or test boundary.
		Object.keys(value as JsonObject)
			.sort()
			// SAFETY: assertion required at this I/O or test boundary.
			.map((key) => [key, sortKeys((value as JsonObject)[key] ?? null)]),
	);
}
