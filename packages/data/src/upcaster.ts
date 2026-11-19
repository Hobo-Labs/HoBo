import type { EventEnvelope } from "@hobo/core";

import { hasFunctionTag } from "./json.js";

export type Upcaster<Input = unknown, Output = unknown> = (
	data: Input,
) => Output;

declare const upcasterVersionBrand: unique symbol;
export type UpcasterVersion = number & {
	readonly [upcasterVersionBrand]: true;
};

export function parseUpcasterVersion(value: number): UpcasterVersion {
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value === Number.MAX_SAFE_INTEGER
	) {
		throw new TypeError(
			"fromVersion must be a positive safe integer with a successor",
		);
	}
	return value as UpcasterVersion;
}

export class UpcasterChainError extends Error {
	constructor(
		readonly eventType: string,
		readonly fromVersion: number,
	) {
		super(
			`non-total upcaster chain for ${eventType}: missing ${fromVersion}->${fromVersion + 1}`,
		);
		this.name = "UpcasterChainError";
	}
}

export interface UpcasterRegistry {
	register(type: string, fromVersion: number, up: Upcaster): this;
	latestVersion(type: string): number;
	assertCanUpcast?(type: string, fromVersion: number): void;
	upcast(event: EventEnvelope): EventEnvelope;
}

function latest(chain: ReadonlyMap<number, Upcaster>): number {
	let version = 1;
	for (const fromVersion of chain.keys()) {
		version = Math.max(version, fromVersion + 1);
	}
	return version;
}

function assertComplete(
	type: string,
	chain: ReadonlyMap<number, Upcaster>,
	fromVersion: number,
): void {
	const targetVersion = latest(chain);
	for (let version = fromVersion; version < targetVersion; version += 1) {
		if (!chain.has(version)) throw new UpcasterChainError(type, version);
	}
}

export function createUpcasterRegistry(): UpcasterRegistry {
	const chains = new Map<string, Map<number, Upcaster>>();

	const registry: UpcasterRegistry = {
		register(type, fromVersion, up) {
			if (!hasFunctionTag(up)) {
				throw new TypeError("upcaster must be a function");
			}
			const version = parseUpcasterVersion(fromVersion);
			const chain = chains.get(type) ?? new Map<number, Upcaster>();
			if (chain.has(version)) {
				throw new Error(
					`duplicate upcaster for ${type} v${fromVersion} -> v${fromVersion + 1}`,
				);
			}
			chain.set(version, up);
			chains.set(type, chain);
			return registry;
		},

		latestVersion(type) {
			const chain = chains.get(type);
			if (!chain) return 1;
			assertComplete(type, chain, 1);
			return latest(chain);
		},

		assertCanUpcast(type, fromVersion) {
			const chain = chains.get(type);
			if (chain) assertComplete(type, chain, fromVersion);
		},

		upcast(event) {
			const chain = chains.get(event.type);
			if (!chain) return event;
			assertComplete(event.type, chain, event.v);
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
