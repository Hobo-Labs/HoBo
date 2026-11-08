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

/**
 * Self-hosting a Station (control-plane occupancy): instead of a provider-run
 * control plane, the OPERATOR owns HOBO_HOME and initializes a durable Station
 * on disk. Rails, occupancy, and pins live under
 * `<hoboHome>/stations/<id>/events.jsonl` and survive process restart.
 *
 * This is the Station-side peer of `examples/self-host-yard` (which composes
 * the app YardRuntime). Station does **not** contain Yards — Bindle ⊂ Camp ⊂
 * Yard ⊂ Junction stays app topology.
 */

export const SELF_HOST_STATION_NAME = "self-host-station";
export const SELF_HOST_STATION_ID = `station:${SELF_HOST_STATION_NAME}`;

export interface SelfHostedStationOptions {
	/**
	 * Operator HOBO_HOME root. Station durable state is written under
	 * `hoboHome/stations/`. Reopening the same path resumes the same Station.
	 */
	readonly hoboHome: string;
	/** Station name (defaults to self-host-station). */
	readonly name?: string;
	readonly tenant?: string;
	readonly residency?: string;
	readonly airgap?: boolean;
	readonly trustDomain?: string;
	/** Optional broker/policy JSON imported as an approved Rail at first init. */
	readonly importRailDocPath?: string;
}

export interface SelfHostedStation {
	readonly hoboHome: string;
	readonly stationId: string;
	/** On-disk Station root (`…/stations/<id>`). */
	readonly dataDir: string;
	/** Whether this open call created the Station (false if reopened). */
	readonly created: boolean;
	/** Local Station client (occupancy, rails, pins). */
	readonly client: StationClient;
	/** Authoring topology object for the Station. */
	readonly topology: Station;
	/** Init snapshot (bootstrap rail, occupancy). */
	readonly init: InitStationResult;
	/** Receipt pins for Broker/Conductor. */
	readonly pins: () => StationPins;
	/** Status summary for operators / tests. */
	readonly status: () => SelfHostedStationStatus;
	/** No-op close — durable state stays on disk (mirrors yard store.close semantics as optional). */
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

/**
 * Author the Station topology object (not durable until init).
 */
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

/**
 * Open (or reopen) a self-hosted Station under `hoboHome`. Idempotent init:
 * first call creates bootstrap Rail + occupancy; later calls load the same
 * durable event log and return created: false.
 */
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
			// File-backed Station has no open handles; durable log remains on disk.
		},
	};
}
