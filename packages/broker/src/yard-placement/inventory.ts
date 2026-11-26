import {
	contentHashOf,
	YARD_INSTANCE_SCHEMA,
	YARD_INVENTORY_SCHEMA,
	YARD_RUNTIME_CATALOG_SCHEMA,
	YARD_RUNTIME_SCHEMA,
	type YardInstanceRegistration,
	type YardInventorySnapshot,
	type YardRuntimeCatalogSnapshot,
	type YardRuntimeRegistration,
} from "./types.js";

export type YardInventoryEvent =
	| {
			readonly type: "yard.Registered";
			readonly yard: YardInstanceRegistration;
	  }
	| {
			readonly type: "yard.StatusChanged";
			readonly yardId: string;
			readonly status: YardInstanceRegistration["status"];
			readonly observedAt: string;
	  }
	| {
			readonly type: "yard.CapacityUpdated";
			readonly yardId: string;
			readonly capacity: YardInstanceRegistration["capacity"];
	  };

/**
 * Event-sourced Yard inventory read model. Selection pins a snapshot hash.
 */
export interface YardInventory {
	readonly apply: (event: YardInventoryEvent) => void;
	readonly snapshot: () => YardInventorySnapshot;
	readonly get: (yardId: string) => YardInstanceRegistration | undefined;
}

export function createYardInventory(brokerId: string): YardInventory {
	const yards = new Map<string, YardInstanceRegistration>();
	let seq = 0;

	return {
		apply(event) {
			seq += 1;
			if (event.type === "yard.Registered") {
				yards.set(event.yard.yardId, {
					...event.yard,
					schemaVersion: YARD_INSTANCE_SCHEMA,
					registrationSeq: event.yard.registrationSeq || seq,
				});
				return;
			}
			const existing = yards.get(event.yardId);
			if (!existing) return;
			if (event.type === "yard.StatusChanged") {
				yards.set(event.yardId, {
					...existing,
					status: event.status,
					health: {
						...existing.health,
						observedAt: event.observedAt,
						generation: existing.health.generation + 1,
					},
				});
				return;
			}
			if (event.type === "yard.CapacityUpdated") {
				yards.set(event.yardId, {
					...existing,
					capacity: event.capacity,
				});
			}
		},
		snapshot() {
			const list = [...yards.values()].sort((a, b) =>
				a.yardId < b.yardId ? -1 : a.yardId > b.yardId ? 1 : 0,
			);
			const body = {
				schemaVersion: YARD_INVENTORY_SCHEMA,
				brokerId,
				seq,
				yards: list,
			};
			return Object.freeze({
				...body,
				yards: Object.freeze(list),
				contentHash: contentHashOf(body),
			});
		},
		get(yardId) {
			return yards.get(yardId);
		},
	};
}

export interface YardRuntimeCatalog {
	readonly register: (runtime: YardRuntimeRegistration) => void;
	readonly snapshot: () => YardRuntimeCatalogSnapshot;
	readonly approvedForProvider: (
		providerId: string,
	) => readonly YardRuntimeRegistration[];
}

export function createYardRuntimeCatalog(): YardRuntimeCatalog {
	const runtimes = new Map<string, YardRuntimeRegistration>();
	let seq = 0;

	return {
		register(runtime) {
			seq += 1;
			runtimes.set(runtime.runtimeId, {
				...runtime,
				schemaVersion: YARD_RUNTIME_SCHEMA,
			});
		},
		snapshot() {
			const list = [...runtimes.values()].sort((a, b) => {
				if (a.priority !== b.priority) return b.priority - a.priority;
				return a.runtimeId < b.runtimeId
					? -1
					: a.runtimeId > b.runtimeId
						? 1
						: 0;
			});
			const body = {
				schemaVersion: YARD_RUNTIME_CATALOG_SCHEMA,
				seq,
				runtimes: list,
			};
			return Object.freeze({
				...body,
				runtimes: Object.freeze(list),
				contentHash: contentHashOf(body),
			});
		},
		approvedForProvider(providerId) {
			return [...runtimes.values()]
				.filter(
					(r) =>
						r.providerId === providerId &&
						r.status === "approved" &&
						Boolean(r.generatorConnectorId),
				)
				.sort((a, b) => {
					if (a.default !== b.default) return a.default ? -1 : 1;
					if (a.priority !== b.priority) return b.priority - a.priority;
					return a.runtimeId < b.runtimeId ? -1 : 1;
				});
		},
	};
}

export function localYardInstance(options: {
	readonly yardId: string;
	readonly ownerTenantId: string;
	readonly providerId: string;
	readonly runtimeId?: string;
	readonly capabilities?: readonly string[];
	readonly componentHosts?: readonly string[];
	readonly regions?: readonly string[];
	readonly residency?: readonly string[];
}): YardInstanceRegistration {
	const now = new Date().toISOString();
	return Object.freeze({
		schemaVersion: YARD_INSTANCE_SCHEMA,
		yardId: options.yardId,
		ownerTenantId: options.ownerTenantId,
		providerId: options.providerId,
		runtimeId: options.runtimeId ?? `${options.providerId}-runtime`,
		layout: Object.freeze({
			providerId: options.providerId,
			regions: Object.freeze([...(options.regions ?? ["local"])]),
			// SAFETY: assertion required at this I/O or test boundary.
			require: Object.freeze([] as string[]),
			// SAFETY: assertion required at this I/O or test boundary.
			prefer: Object.freeze([] as string[]),
			residency: Object.freeze([...(options.residency ?? [])]),
			// SAFETY: assertion required at this I/O or test boundary.
			isolation: Object.freeze([] as string[]),
			// SAFETY: assertion required at this I/O or test boundary.
			network: Object.freeze([] as string[]),
			componentHosts: Object.freeze([
				...(options.componentHosts ?? ["local", "wasm", "oci"]),
			]),
			labels: Object.freeze({}),
			properties: Object.freeze({}),
			camps: Object.freeze([]),
		}),
		capabilities: Object.freeze([
			...(options.capabilities ?? [
				"managed-http-runtime",
				"host:local",
				"host:wasm",
				"host:oci",
				"runtime:wasm",
				"runtime:oci",
			]),
		]),
		status: "ready",
		health: Object.freeze({
			observedAt: now,
			generation: 1,
			signals: Object.freeze(["ok"]),
		}),
		capacity: Object.freeze({
			classes: Object.freeze({ default: 1000 }),
			reservations: Object.freeze({}),
		}),
		registryCatalogHash: contentHashOf("local-registry"),
		resolverCatalogHash: contentHashOf("local-resolvers"),
		conformanceHash: contentHashOf("local-conformance"),
		labels: Object.freeze({}),
		registrationSeq: 1,
	});
}
