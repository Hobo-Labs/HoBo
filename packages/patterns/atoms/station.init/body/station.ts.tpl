import { initStation, station } from "@hobo/stations";

export const STATION_NAME = "{{name}}";
export const STATION_ID = `station:${STATION_NAME}`;

export function openAppStation(hoboHome: string) {
	const topology = station(STATION_NAME);
	const init = initStation({
		hoboHome,
		name: STATION_NAME,
	});
	return { topology, init, stationId: STATION_ID };
}
