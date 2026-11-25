/**
 * station() Bindle-style idiom: control-plane occupancy primitive.
 * Station is NOT app-topology containment (not a parent of Yard).
 */
import { isJsonObject, isJsonString } from "./json.js";
import {
	STATION_CONTRACT_VERSION,
	STATION_SCHEMA_VERSION,
	type Station,
	type StationConfig,
	type StationIsolation,
} from "./types.js";

function requireName(label: string, value: string): void {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		return Object.freeze(value);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

/**
 * Declare a Station Bindle shape. Full dogfood parallel to yard()/junction().
 * Connections and Rails remain Station aggregates (not Bindle graph resources).
 */
export function station(
	name: string,
	config: StationConfig = { isolation: {} },
): Station {
	requireName("station name", name);
	if (!config || !isJsonObject(config)) {
		throw new TypeError("station config must be an object");
	}
	const iso = config.isolation ?? {};
	const isolation: StationIsolation = Object.freeze({
		tenant: iso.tenant ?? name,
		residency: iso.residency ?? "local",
		airgap: iso.airgap === true,
		trustDomain: iso.trustDomain ?? `${name}.hobo.local`,
		// ADR-0133: exactly-one-class is the declaration's commitment; no
		// default is invented here — an absent class stays absent.
		...(iso.isolationClass !== undefined
			? { isolationClass: iso.isolationClass }
			: undefined),
	});
	const railRefs = Object.freeze([...(config.rails ?? [])]);
	const capabilities = Object.freeze([...(config.capabilities ?? [])]);
	const metadata = Object.freeze({ ...config.metadata });
	return deepFreeze({
		kind: "station" as const,
		contract: STATION_CONTRACT_VERSION,
		schemaVersion: STATION_SCHEMA_VERSION,
		id: `station:${name}`,
		name,
		isolation,
		status: "open" as const,
		railRefs,
		capabilities,
		metadata,
	});
}
