/**
 * Local alias so try-site samples can write `station({ yards })` while the
 * production `@hobo/stations` `station(name, config)` Bindle stays unchanged.
 */
export { environmentStation as station } from "./environment-station.js";
export type {
	EnvironmentStation,
	EnvironmentStationConfig,
	EnvironmentStationYard,
} from "./environment-station.js";
