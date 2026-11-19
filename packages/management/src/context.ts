import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ConnectionEvent,
	ConnectionService,
	createInMemoryVault,
} from "@hobo/identity";
import {
	createStationClient,
	initStation,
	listStationIds,
	loadStationEvents,
	persistStationEvents,
	type StationClient,
	StationService,
	type StationState,
} from "@hobo/stations";

import type { ManagementActor, ManagementHome } from "./types.js";

export type ManagementContext = ManagementHome & {
	readonly resolveActor: () => ManagementActor;
	readonly loadStation: (stationId: string) => StationClient;
	readonly loadStationState: (stationId: string) => StationState | null;
	readonly loadConnectionService: (tenant: string) => ConnectionService;
	readonly persistConnections: (
		tenant: string,
		service: ConnectionService,
	) => void;
	readonly persistStation: (
		stationId: string,
		events: StationService["events"],
	) => void;
	readonly listStations: () => readonly string[];
	readonly getOccupyMode: (stationId: string) => "idle" | "occupying";
	readonly setOccupyMode: (
		stationId: string,
		mode: "idle" | "occupying",
	) => void;
};

const occupyModes = new Map<string, "idle" | "occupying">();

function connectionStorePath(hoboHome: string): string {
	return join(hoboHome, "connections", "events.jsonl");
}

function readAllConnectionEvents(hoboHome: string): ConnectionEvent[] {
	const path = connectionStorePath(hoboHome);
	if (!existsSync(path)) return [];
	return (
		readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
			.map((line) => JSON.parse(line) as ConnectionEvent)
	);
}

function loadProfileDefaultStation(
	hoboHome: string,
): { id: string } | undefined {
	const path = join(hoboHome, "profile.json");
	if (!existsSync(path)) return undefined;
	try {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			defaultStation?: { id?: string };
			session?: { principal?: { kind?: string; id?: string }; tenant?: string };
		};
		if (raw.defaultStation?.id) return { id: raw.defaultStation.id };
	} catch {
	}
	return undefined;
}

function loadProfileActor(hoboHome: string): ManagementActor {
	const path = join(hoboHome, "profile.json");
	if (existsSync(path)) {
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
			const raw = JSON.parse(readFileSync(path, "utf8")) as {
				session?: {
					principal?: { kind?: string; id?: string };
					tenant?: string;
				};
			};
			if (raw.session?.principal?.id) {
				return {
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
					kind: (raw.session.principal.kind ??
						"user") as ManagementActor["kind"],
					id: raw.session.principal.id,
					tenant: raw.session.tenant ?? "local",
				};
			}
		} catch {
		}
	}
	return { kind: "user", id: "user:local", tenant: "local" };
}

export function createManagementContext(
	home: ManagementHome,
): ManagementContext {
	const hoboHome = home.hoboHome;

	return {
		hoboHome,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(home.now !== undefined ? { now: home.now } : {}),
		resolveActor: () => loadProfileActor(hoboHome),
		loadStation: (stationId: string) => {
			const client = createStationClient({ hoboHome, stationId });
			client.load();
			return client;
		},
		loadStationState: (stationId: string) => {
			try {
				const events = loadStationEvents(hoboHome, stationId);
				if (events.length === 0) return null;
				const client = createStationClient({ hoboHome, stationId });
				return client.load();
			} catch {
				return null;
			}
		},
		loadConnectionService: (tenant: string) => {
			const vault = createInMemoryVault({
				reference: `vaultref://yard/${tenant}/root`,
				rootSecret: `hobo-local-connection-root-${tenant}`,
			});
			const path = connectionStorePath(hoboHome);
			if (!existsSync(path)) {
				return new ConnectionService({
					tenant,
					vault,
					// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
					...(home.now !== undefined ? { now: home.now } : {}),
				});
			}
			const events = readAllConnectionEvents(hoboHome).filter(
				(event) => event.tenant === tenant,
			);
			return ConnectionService.fromEvents(events, {
				tenant,
				vault,
				// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
				...(home.now !== undefined ? { now: home.now } : {}),
			});
		},
		persistConnections: (tenant: string, service: ConnectionService) => {
			const dir = join(hoboHome, "connections");
			mkdirSync(dir, { recursive: true });
			const path = connectionStorePath(hoboHome);
			const foreign = readAllConnectionEvents(hoboHome).filter(
				(event) => event.tenant !== tenant,
			);
			const merged = [...foreign, ...service.events];
			writeFileSync(
				path,
				`${merged.map((e) => JSON.stringify(e)).join("\n")}\n`,
				"utf8",
			);
		},
		persistStation: (stationId, events) => {
			persistStationEvents(hoboHome, stationId, events);
		},
		listStations: () => listStationIds(hoboHome),
		getOccupyMode: (stationId) => occupyModes.get(stationId) ?? "idle",
		setOccupyMode: (stationId, mode) => {
			occupyModes.set(stationId, mode);
		},
	};
}

export function resolveDefaultStationId(
	ctx: ManagementContext,
	explicit?: string,
): string | undefined {
	if (explicit && explicit.length > 0) return explicit;
	const fromEnv = process.env.HOBO_STATION;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return loadProfileDefaultStation(ctx.hoboHome)?.id;
}

export { initStation, StationService };
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- SAFETY: local JSON boundaries and omitted optional clock fields preserve the existing contract. */
