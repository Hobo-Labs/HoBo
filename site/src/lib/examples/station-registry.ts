import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonTree,
	type JsonValue,
} from "../json-inspect.js";
import type {
	BudgetPolicy,
	Redundancy,
	ResourceClass,
	RoutingPolicy,
} from "./policy-planner.js";

export const STATION_REGISTRY_KEY = "hobo-examples-stations";

export interface DeployedStation {
	readonly id: string;
	readonly targetId: string;
	readonly yardId: string;
	readonly providerId: string;
	readonly policy: BudgetPolicy;
	readonly label: string;
	readonly createdAt: string;
	/** Remote anonymous station endpoint (operator bootstrap). Absent for local. */
	readonly endpointUrl?: string;
	/** Cloudflare Temporary Accounts claim URL (~60m). */
	readonly claimUrl?: string;
	/** ISO expiry for temporary stations. */
	readonly expiresAt?: string;
}

export interface StationRegistry {
	readonly homeStationId: string;
	readonly stations: readonly DeployedStation[];
}

type MutableDeployedStation = {
	id: string;
	targetId: string;
	yardId: string;
	providerId: string;
	policy: BudgetPolicy;
	label: string;
	createdAt: string;
	endpointUrl?: string;
	claimUrl?: string;
	expiresAt?: string;
};

export function emptyStationRegistry(homeStationId: string): StationRegistry {
	return { homeStationId, stations: [] };
}

export function loadStationRegistry(
	storage: Pick<Storage, "getItem"> | null | undefined,
	homeStationId: string,
): StationRegistry {
	if (!storage) return emptyStationRegistry(homeStationId);
	const raw = storage.getItem(STATION_REGISTRY_KEY);
	if (!raw) return emptyStationRegistry(homeStationId);
	try {
		return parseStationRegistry(parseJsonTree(raw), homeStationId);
	} catch {
		return emptyStationRegistry(homeStationId);
	}
}

export function saveStationRegistry(
	storage: Pick<Storage, "setItem"> | null | undefined,
	registry: StationRegistry,
): void {
	if (!storage) return;
	storage.setItem(STATION_REGISTRY_KEY, JSON.stringify(registry));
}

export function parseStationRegistry(
	value: JsonValue,
	fallbackHomeStationId: string,
): StationRegistry {
	if (!isJsonObject(value)) {
		return emptyStationRegistry(fallbackHomeStationId);
	}
	const homeStationId =
		isJsonString(value.homeStationId) && value.homeStationId.length > 0
			? value.homeStationId
			: fallbackHomeStationId;
	if (!isJsonArray(value.stations)) {
		return emptyStationRegistry(homeStationId);
	}
	const stations: DeployedStation[] = [];
	for (const entry of value.stations) {
		const station = parseStation(entry);
		if (station) stations.push(station);
	}
	return { homeStationId, stations };
}

function parseStation(value: JsonValue): DeployedStation | null {
	if (!isJsonObject(value)) return null;
	const policy = parsePolicy(value.policy);
	if (!policy) return null;
	if (
		!isJsonString(value.id) ||
		!isJsonString(value.targetId) ||
		!isJsonString(value.yardId) ||
		!isJsonString(value.providerId) ||
		!isJsonString(value.label) ||
		!isJsonString(value.createdAt)
	) {
		return null;
	}
	const station: MutableDeployedStation = {
		id: value.id,
		targetId: value.targetId,
		yardId: value.yardId,
		providerId: value.providerId,
		policy,
		label: value.label,
		createdAt: value.createdAt,
	};
	if (isJsonString(value.endpointUrl) && value.endpointUrl.length > 0) {
		station.endpointUrl = value.endpointUrl;
	}
	if (isJsonString(value.claimUrl) && value.claimUrl.length > 0) {
		station.claimUrl = value.claimUrl;
	}
	if (isJsonString(value.expiresAt) && value.expiresAt.length > 0) {
		station.expiresAt = value.expiresAt;
	}
	return station;
}

function parsePolicy(value: JsonValue | undefined): BudgetPolicy | null {
	if (value === undefined || !isJsonObject(value)) return null;
	const routing = parseRouting(value.routing);
	const redundancy = parseRedundancy(value.redundancy);
	const resourcePool = parseResourcePool(value.resourcePool);
	if (
		!isJsonBoolean(value.preferLocal) ||
		routing === null ||
		redundancy === null ||
		!isJsonNumber(value.maxReplicas) ||
		!isJsonNumber(value.maxConcurrent) ||
		!isJsonNumber(value.monthlySpendCapUsd) ||
		resourcePool === null
	) {
		return null;
	}
	return {
		preferLocal: value.preferLocal,
		routing,
		redundancy,
		maxReplicas: value.maxReplicas,
		maxConcurrent: value.maxConcurrent,
		monthlySpendCapUsd: value.monthlySpendCapUsd,
		resourcePool,
	};
}

function parseRouting(value: JsonValue | undefined): RoutingPolicy | null {
	if (!isJsonString(value)) return null;
	for (const choice of ["local-first", "latency-first", "cost-first"] as const) {
		if (choice === value) return choice;
	}
	return null;
}

function parseRedundancy(value: JsonValue | undefined): Redundancy | null {
	if (!isJsonString(value)) return null;
	for (const choice of ["none", "active-passive", "active-active", "mirror"] as const) {
		if (choice === value) return choice;
	}
	return null;
}

function parseResourcePool(
	value: JsonValue | undefined,
): ResourceClass[] | null {
	if (!isJsonArray(value)) return null;
	const pool: ResourceClass[] = [];
	for (const entry of value) {
		const cls = parseResourceClass(entry);
		if (cls === null) return null;
		pool.push(cls);
	}
	return pool;
}

function parseResourceClass(value: JsonValue): ResourceClass | null {
	if (!isJsonString(value)) return null;
	for (const choice of ["local", "anonymous-remote", "paid-remote"] as const) {
		if (choice === value) return choice;
	}
	return null;
}
