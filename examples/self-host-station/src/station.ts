import { mkdirSync } from "node:fs";

import {
	createStationClient,
	initStation,
	listStationIds,
	station,
	type InitStationResult,
	type Station,
	type StationClient,
	type StationPins,
} from "@hobo/stations";

export const SELF_HOST_STATION_NAME = "self-host-station";
export const SELF_HOST_STATION_ID = `station:${SELF_HOST_STATION_NAME}`;

export interface SelfHostedStationOptions {
	readonly hoboHome: string;
	readonly name?: string;
	readonly tenant?: string;
	readonly residency?: string;
	readonly airgap?: boolean;
	readonly trustDomain?: string;
	readonly importRailDocPath?: string;
}

export interface SelfHostedStation {
	readonly hoboHome: string;
	readonly stationId: string;
	readonly dataDir: string;
	readonly created: boolean;
	readonly client: StationClient;
	readonly topology: Station;
	readonly init: InitStationResult;
	readonly pins: () => StationPins;
	readonly status: () => SelfHostedStationStatus;
	readonly close: () => void;
}

export interface SelfHostedStationStatus {
	readonly stationId: string;
	readonly dataDir: string;
	readonly created: boolean;
	readonly isolation: {
		readonly tenant: string;
		readonly residency: string;
		readonly airgap: boolean;
		readonly trustDomain: string;
	};
	readonly pins: StationPins;
	readonly knownStations: readonly string[];
}

export function selfHostStationTopology(
	name: string = SELF_HOST_STATION_NAME,
): Station {
	return station(name, {
		isolation: {
			tenant: name,
			residency: "local",
			airgap: false,
			trustDomain: `${name}.hobo.local`,
		},
	});
}

export function openSelfHostedStation(
	options: SelfHostedStationOptions,
): SelfHostedStation {
	const hoboHome = options.hoboHome;
	mkdirSync(hoboHome, { recursive: true });
	const name = options.name ?? SELF_HOST_STATION_NAME;
	const initInput: SelfHostedStationOptions = { ...options, hoboHome, name };
	const init = initStation(initInput);
	const client = createStationClient({
		hoboHome,
		stationId: init.stationId,
	});
	const topology = selfHostStationTopology(name);

	return {
		hoboHome,
		stationId: init.stationId,
		dataDir: init.dataDir,
		created: init.created,
		client,
		topology,
		init,
		pins: () => client.pins(),
		status: () => {
			const occ = client.occupancy();
			const pins = client.pins();
			return Object.freeze({
				stationId: init.stationId,
				dataDir: init.dataDir,
				created: init.created,
				isolation: {
					tenant: occ.isolation.tenant,
					residency: occ.isolation.residency,
					airgap: occ.isolation.airgap,
					trustDomain: occ.isolation.trustDomain,
				},
				pins,
				knownStations: listStationIds(hoboHome),
			});
		},
		close: () => {
		},
	};
}
