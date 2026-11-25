type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export type EnvironmentStationYard = {
	readonly providerId?: string;
	readonly with?: JsonValue;
	readonly [key: string]: JsonValue | undefined;
};

export type EnvironmentStationConfig = {
	readonly yards: readonly EnvironmentStationYard[];
};

export type EnvironmentStation = {
	readonly kind: "environment-station";
	readonly yards: readonly EnvironmentStationYard[];
};

export function environmentStation(
	config: EnvironmentStationConfig,
): EnvironmentStation {
	if (!config || Object.prototype.toString.call(config) !== "[object Object]") {
		throw new TypeError("environmentStation config must be an object");
	}
	if (!Array.isArray(config.yards)) {
		throw new TypeError("environmentStation config.yards must be an array");
	}
	return Object.freeze({
		kind: "environment-station" as const,
		yards: Object.freeze([...config.yards]),
	});
}
