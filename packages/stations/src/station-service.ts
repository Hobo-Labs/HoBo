/**
 * Event-sourced Station occupancy aggregate: Station + Rails.
 * Connections are Station-scoped via stationId on the identity plane.
 */

import { STATION_EVENTS, type StationEvent, stationEvent } from "./events.js";
import { asJsonObject, isJsonNumber, type JsonObject } from "./json.js";
import { createBootstrapRail, createRail, parseRail } from "./rail.js";
import type { Rail, StationIsolation, StationOccupancy } from "./types.js";

export interface StationCreateResult {
	readonly occupancy: StationOccupancy;
	readonly bootstrap: Rail;
}

export type StationState = Readonly<{
	occupancy: StationOccupancy;
	rails: Readonly<Record<string, Rail>>;
	events: readonly StationEvent[];
}>;

type MutableOccupancy = {
	stationId: string;
	dataDir: string;
	status: StationOccupancy["status"];
	isolation: StationIsolation;
	activeRailHash?: `sha256:${string}`;
	bootstrapRailHash?: `sha256:${string}`;
	bootstrapActive: boolean;
	connectionCount: number;
	createdAt: string;
	updatedAt: string;
	seq: number;
};

function freezeOccupancy(o: MutableOccupancy): StationOccupancy {
	return Object.freeze({
		stationId: o.stationId,
		dataDir: o.dataDir,
		status: o.status,
		isolation: o.isolation,
		bootstrapActive: o.bootstrapActive,
		connectionCount: o.connectionCount,
		createdAt: o.createdAt,
		updatedAt: o.updatedAt,
		seq: o.seq,
		...(o.activeRailHash !== undefined
			? { activeRailHash: o.activeRailHash }
			: undefined),
		...(o.bootstrapRailHash !== undefined
			? { bootstrapRailHash: o.bootstrapRailHash }
			: undefined),
	});
}

export function foldStationEvents(
	events: readonly StationEvent[],
): StationState | null {
	let occupancy: MutableOccupancy | null = null;
	const rails: Record<string, Rail> = {};

	for (const event of events) {
		const data = event.data;
		switch (event.type) {
			case STATION_EVENTS.Created: {
				// SAFETY: assertion required at this I/O or test boundary.
				const isolation = data.isolation as StationIsolation;
				// SAFETY: assertion required at this I/O or test boundary.
				const bootstrapHash = data.bootstrapRailHash as
					| `sha256:${string}`
					| undefined;
				occupancy = {
					stationId: event.stationId,
					dataDir: String(data.dataDir ?? ""),
					status: "open",
					isolation,
					bootstrapActive: true,
					connectionCount: 0,
					createdAt: event.time,
					updatedAt: event.time,
					seq: event.seq,
					...(bootstrapHash !== undefined
						? {
								bootstrapRailHash: bootstrapHash,
								activeRailHash: bootstrapHash,
							}
						: undefined),
				};
				if (data.bootstrapRail !== undefined) {
					const rail = parseRail(data.bootstrapRail);
					rails[rail.contentHash] = rail;
				}
				break;
			}
			case STATION_EVENTS.Configured: {
				if (!occupancy) break;
				occupancy.updatedAt = event.time;
				occupancy.seq = event.seq;
				if (isJsonNumber(data.connectionCount)) {
					occupancy.connectionCount = data.connectionCount;
				}
				break;
			}
			case STATION_EVENTS.Closed: {
				if (!occupancy) break;
				occupancy.status = "closed";
				occupancy.updatedAt = event.time;
				occupancy.seq = event.seq;
				break;
			}
			case STATION_EVENTS.IdentityRotated: {
				if (!occupancy) break;
				occupancy.updatedAt = event.time;
				occupancy.seq = event.seq;
				break;
			}
			case STATION_EVENTS.RailPublished:
			case STATION_EVENTS.RailApproved: {
				// SAFETY: assertion required at this I/O or test boundary.
				const rail = data.rail as Rail | undefined;
				if (rail?.contentHash) {
					rails[rail.contentHash] = rail;
				}
				if (occupancy) {
					occupancy.updatedAt = event.time;
					occupancy.seq = event.seq;
				}
				break;
			}
			case STATION_EVENTS.RailActivated: {
				// SAFETY: assertion required at this I/O or test boundary.
				const hash = data.contentHash as `sha256:${string}` | undefined;
				const isBootstrap = data.isBootstrap === true;
				if (occupancy && hash) {
					occupancy.activeRailHash = hash;
					occupancy.bootstrapActive = isBootstrap;
					occupancy.updatedAt = event.time;
					occupancy.seq = event.seq;
				}
				if (hash && rails[hash]) {
					rails[hash] = Object.freeze({
						...rails[hash],
						activationStatus: "active" as const,
					});
				}
				for (const [h, r] of Object.entries(rails)) {
					if (h !== hash && r.activationStatus === "active") {
						rails[h] = Object.freeze({
							...r,
							activationStatus: "approved" as const,
						});
					}
				}
				break;
			}
			case STATION_EVENTS.RailDeactivated:
			case STATION_EVENTS.RailRetired: {
				// SAFETY: assertion required at this I/O or test boundary.
				const hash = data.contentHash as string | undefined;
				if (hash && rails[hash]) {
					rails[hash] = Object.freeze({
						...rails[hash],
						activationStatus:
							event.type === STATION_EVENTS.RailRetired
								? ("retired" as const)
								: ("approved" as const),
					});
				}
				if (occupancy) {
					occupancy.updatedAt = event.time;
					occupancy.seq = event.seq;
					if (hash !== undefined && hash === occupancy.activeRailHash) {
						delete occupancy.activeRailHash;
					}
					occupancy.bootstrapActive =
						occupancy.activeRailHash !== undefined &&
						occupancy.activeRailHash === occupancy.bootstrapRailHash;
				}
				break;
			}
			default:
				break;
		}
	}

	if (!occupancy) return null;
	return Object.freeze({
		occupancy: freezeOccupancy(occupancy),
		rails: Object.freeze({ ...rails }),
		events: Object.freeze([...events]),
	});
}

export class StationService {
	readonly stationId: string;
	readonly events: StationEvent[] = [];
	private seq = 0;
	private readonly now: () => string;

	constructor(options: {
		readonly stationId: string;
		readonly now?: () => string;
	}) {
		this.stationId = options.stationId;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	static fromEvents(
		events: readonly StationEvent[],
		options: { readonly stationId: string; readonly now?: () => string },
	): StationService {
		const svc = new StationService(options);
		for (const e of events) {
			svc.events.push(e);
			svc.seq = Math.max(svc.seq, e.seq);
		}
		return svc;
	}

	private append(type: StationEvent["type"], data: JsonObject): StationEvent {
		this.seq += 1;
		const evt = stationEvent(type, this.stationId, this.seq, data, this.now());
		this.events.push(evt);
		return evt;
	}

	create(input: {
		readonly name: string;
		readonly isolation: StationIsolation;
		readonly dataDir: string;
	}): StationCreateResult {
		if (this.events.length > 0) {
			throw Object.assign(new Error("station already initialized"), {
				code: "station-already-exists",
			});
		}
		const bootstrap = createBootstrapRail(this.stationId, this.now());
		this.append(
			STATION_EVENTS.Created,
			asJsonObject({
				name: input.name,
				isolation: input.isolation,
				dataDir: input.dataDir,
				bootstrapRailHash: bootstrap.contentHash,
				bootstrapRail: bootstrap,
			}),
		);
		const state = this.snapshot();
		if (!state) throw new Error("station create fold failed");
		return { occupancy: state.occupancy, bootstrap };
	}

	publishRail(input: Parameters<typeof createRail>[0]): Rail {
		const rail = createRail({
			...input,
			stationId: this.stationId,
			activationStatus: input.activationStatus ?? "draft",
			now: this.now(),
		});
		this.append(
			STATION_EVENTS.RailPublished,
			asJsonObject({
				rail,
				contentHash: rail.contentHash,
				railId: rail.id,
			}),
		);
		return rail;
	}

	approveRail(contentHash: string): void {
		const state = this.snapshot();
		const rail = state?.rails[contentHash];
		if (!rail) {
			throw Object.assign(new Error(`rail ${contentHash} not found`), {
				code: "rail-not-found",
			});
		}
		const approved = Object.freeze({
			...rail,
			activationStatus: "approved" as const,
		});
		this.append(
			STATION_EVENTS.RailApproved,
			asJsonObject({
				rail: approved,
				contentHash,
				railId: rail.id,
			}),
		);
	}

	activateRail(contentHash: string): void {
		const state = this.snapshot();
		const rail = state?.rails[contentHash];
		if (!rail) {
			throw Object.assign(new Error(`rail ${contentHash} not found`), {
				code: "rail-not-found",
			});
		}
		if (rail.activationStatus === "retired") {
			throw Object.assign(new Error("cannot activate retired rail"), {
				code: "rail-retired",
			});
		}
		this.append(STATION_EVENTS.RailActivated, {
			railId: rail.id,
			contentHash,
			isBootstrap: rail.isBootstrap,
		});
	}

	retireRail(contentHash: string): void {
		this.append(STATION_EVENTS.RailRetired, { contentHash });
	}

	close(): void {
		this.append(STATION_EVENTS.Closed, {});
	}

	setConnectionCount(count: number): void {
		this.append(STATION_EVENTS.Configured, { connectionCount: count });
	}

	snapshot(): StationState | null {
		return foldStationEvents(this.events);
	}

	activeRail(): Rail | null {
		const state = this.snapshot();
		if (!state?.occupancy.activeRailHash) return null;
		return state.rails[state.occupancy.activeRailHash] ?? null;
	}

	assertNotBootstrapOnlyInProd(posture: "dev" | "production"): void {
		const state = this.snapshot();
		if (posture === "production" && state?.occupancy.bootstrapActive === true) {
			throw Object.assign(
				new Error(
					"bootstrap Rail still active in production posture; activate a non-bootstrap Rail",
				),
				{ code: "bootstrap-rail-forbidden" },
			);
		}
	}
}
