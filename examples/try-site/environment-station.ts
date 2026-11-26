/**
 * Examples/console Environment Station deploy declaration.
 *
 * This is **not** ADR-0131 `@hobo/stations` `station(name, config)` (control-plane
 * occupancy Bindle — Station does not contain Yards). Pool Code shows the call
 * shape as `station({ yards })` via the local `./station.js` re-export so authors
 * see provider-extension DX: import plugins, list them, deploy.
 */
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
