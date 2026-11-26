/**
 * Local Station store + client used by Broker (Conductor) and CLI.
 * Durable state lives under HOBO_HOME/stations/<id>/; Conductor holds no long-lived secrets.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseStationEvent, type StationEvent } from "./events.js";
import { isJsonString, type JsonObject } from "./json.js";
import { railFromBrokerConfig } from "./rail.js";
import {
	foldStationEvents,
	StationService,
	type StationState,
} from "./station-service.js";
import type { Rail, StationIsolation, StationOccupancy } from "./types.js";

export type StationPins = Readonly<{
	stationId: string;
	railHash: `sha256:${string}`;
	bootstrapActive: boolean;
}>;

export type StationClient = Readonly<{
	stationId: string;
	dataDir: string;
	load: () => StationState;
	occupancy: () => StationOccupancy;
	activeRail: () => Rail;
	/** Pins for receipts — always complete (stationId + active railHash). */
	pins: () => StationPins;
}>;

export function stationRoot(hoboHome: string, stationId: string): string {
	const safe = stationId.replace(/[^a-zA-Z0-9._:-]/g, "_");
	// Replacing separators is not enough on its own, because `.` is inside the
	// safe class: a station id of `..` sanitized to `..` and `join` then
	// normalized it away, so `stationRoot(home, "..")` returned HOBO_HOME itself
	// and `persistStationEvents` wrote `HOBO_HOME/events.jsonl` — outside the
	// per-station directory entirely (`"."` landed on `stations/events.jsonl`
	// the same way). A station id reaches here from `--station`, HOBO_STATION,
	// and the profile, so it is attacker-adjacent input. A name that is only
	// dots has no legitimate use, so neutralize it rather than rejecting: the
	// resulting directory is still deterministic and still inside HOBO_HOME.
	const contained = /^\.+$/u.test(safe) ? safe.replace(/\./g, "_") : safe;
	return join(hoboHome, "stations", contained);
}

export function stationEventsPath(hoboHome: string, stationId: string): string {
	return join(stationRoot(hoboHome, stationId), "events.jsonl");
}

export function loadStationEvents(
	hoboHome: string,
	stationId: string,
): StationEvent[] {
	const path = stationEventsPath(hoboHome, stationId);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => parseStationEvent(line));
}

export function persistStationEvents(
	hoboHome: string,
	stationId: string,
	events: readonly StationEvent[],
): void {
	const root = stationRoot(hoboHome, stationId);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		stationEventsPath(hoboHome, stationId),
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		"utf8",
	);
}

function requireState(hoboHome: string, stationId: string): StationState {
	const events = loadStationEvents(hoboHome, stationId);
	const state = foldStationEvents(events);
	if (!state) {
		throw Object.assign(
			new Error(`station ${stationId} not found — run hobo station init`),
			{ code: "station-missing", remediation: "hobo station init" },
		);
	}
	return state;
}

export function createStationClient(input: {
	readonly hoboHome: string;
	readonly stationId: string;
}): StationClient {
	const { hoboHome, stationId } = input;
	return {
		stationId,
		dataDir: stationRoot(hoboHome, stationId),
		load() {
			return requireState(hoboHome, stationId);
		},
		occupancy() {
			return this.load().occupancy;
		},
		activeRail() {
			const state = this.load();
			const hash = state.occupancy.activeRailHash;
			if (!hash) {
				throw Object.assign(
					new Error(
						`station ${stationId} has no active Rail — activate a Rail`,
					),
					{
						code: "rail-inactive",
						remediation: "hobo station rails activate <hash>",
					},
				);
			}
			const rail = state.rails[hash];
			if (!rail) {
				throw Object.assign(
					new Error(`active Rail ${hash} missing from Station catalog`),
					{ code: "rail-not-found" },
				);
			}
			return rail;
		},
		pins() {
			const rail = this.activeRail();
			return Object.freeze({
				stationId,
				railHash: rail.contentHash,
				bootstrapActive: rail.isBootstrap,
			});
		},
	};
}

export type InitStationResult = Readonly<{
	stationId: string;
	dataDir: string;
	occupancy: StationOccupancy;
	bootstrap: Rail;
	created: boolean;
	/** Non-bootstrap Rail activated from an imported policy document, if any. */
	activatedRailHash?: `sha256:${string}`;
}>;

/**
 * Create Station under HOBO_HOME. Idempotent: re-init returns existing Station.
 * No silent auto-create elsewhere — callers must invoke init explicitly.
 */
export function initStation(input: {
	readonly hoboHome: string;
	readonly id?: string;
	readonly name?: string;
	readonly tenant?: string;
	readonly residency?: string;
	readonly airgap?: boolean;
	readonly trustDomain?: string;
	/**
	 * Optional policy document (e.g. project hobo.broker.json) published and
	 * activated as the Station's non-bootstrap Rail at init time.
	 */
	readonly importRailDocPath?: string;
}): InitStationResult {
	const name = input.name ?? "local";
	const stationId = input.id ?? `station:${name}`;
	const existing = loadStationEvents(input.hoboHome, stationId);
	if (existing.length > 0) {
		const state = foldStationEvents(existing);
		if (!state) {
			throw new Error("corrupt station event log");
		}
		const bootstrapHash = state.occupancy.bootstrapRailHash;
		const bootstrap =
			(bootstrapHash ? state.rails[bootstrapHash] : undefined) ??
			Object.values(state.rails).find((r) => r.isBootstrap);
		if (!bootstrap) {
			throw new Error("station missing bootstrap rail");
		}
		return {
			stationId,
			dataDir: stationRoot(input.hoboHome, stationId),
			occupancy: state.occupancy,
			bootstrap,
			created: false,
			...(state.occupancy.activeRailHash !== undefined &&
			state.occupancy.activeRailHash !== bootstrap.contentHash
				? { activatedRailHash: state.occupancy.activeRailHash }
				: undefined),
		};
	}

	const isolation: StationIsolation = Object.freeze({
		tenant: input.tenant ?? name,
		residency: input.residency ?? "local",
		airgap: input.airgap === true,
		trustDomain: input.trustDomain ?? `${name}.hobo.local`,
	});
	const dataDir = stationRoot(input.hoboHome, stationId);
	const svc = new StationService({ stationId });
	const { bootstrap } = svc.create({
		name,
		isolation,
		dataDir,
	});

	let activatedRailHash: `sha256:${string}` | undefined;
	const railDocPath = input.importRailDocPath;
	if (railDocPath && existsSync(railDocPath)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const raw = JSON.parse(readFileSync(railDocPath, "utf8")) as JsonObject;
		const imported = railFromBrokerConfig(stationId, raw);
		const published = svc.publishRail({
			id: imported.id,
			name: imported.name,
			version: imported.version,
			stationId,
			policyPacks: imported.policyPacks,
			policyEngine: imported.policyEngine,
			placementDefaults: imported.placementDefaults,
			billingPolicy: imported.billingPolicy,
			deliveryPolicy: imported.deliveryPolicy,
			metadata: imported.metadata,
			activationStatus: "approved",
		});
		svc.approveRail(published.contentHash);
		svc.activateRail(published.contentHash);
		activatedRailHash = published.contentHash;
	}

	persistStationEvents(input.hoboHome, stationId, svc.events);
	const snap = svc.snapshot();
	if (snap === null || snap === undefined) {
		// The service just created this station, so a missing snapshot means the
		// create path silently failed — surface that rather than dereferencing.
		throw new Error(
			`station ${stationId}: no snapshot after create; the station was not initialized`,
		);
	}
	return {
		stationId,
		dataDir,
		occupancy: snap.occupancy,
		bootstrap,
		created: true,
		...(activatedRailHash !== undefined ? { activatedRailHash } : undefined),
	};
}

/** List station ids under HOBO_HOME/stations. */
export function listStationIds(hoboHome: string): readonly string[] {
	const root = join(hoboHome, "stations");
	if (!existsSync(root)) return [];
	return Object.freeze(
		readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort(),
	);
}

/**
 * Resolve Station context: flags → env → profile → single local Station → fail.
 * Never auto-creates durable Station state.
 */
export interface ResolvedStationContext {
	readonly stationId: string;
	readonly client: StationClient;
}

export function resolveStationContext(input: {
	readonly hoboHome: string;
	readonly stationFlag?: string;
	readonly stationEnv?: string;
	readonly profileStationId?: string;
}): ResolvedStationContext {
	const candidates = [
		input.stationFlag,
		input.stationEnv,
		input.profileStationId,
	].filter((v): v is string => isJsonString(v) && v.length > 0);

	for (const id of candidates) {
		const events = loadStationEvents(input.hoboHome, id);
		if (events.length > 0) {
			return {
				stationId: id,
				client: createStationClient({
					hoboHome: input.hoboHome,
					stationId: id,
				}),
			};
		}
	}

	const ids = listStationIds(input.hoboHome);
	const dirName = ids.length === 1 ? ids[0] : undefined;
	if (dirName !== undefined) {
		const eventsPath = join(
			input.hoboHome,
			"stations",
			dirName,
			"events.jsonl",
		);
		if (existsSync(eventsPath)) {
			// Prefer the id from the first event when the directory name is
			// escaped. An empty or unreadable first line means the file carries no
			// usable id, so fall back to the directory rather than dereferencing
			// nothing.
			const firstLine = readFileSync(eventsPath, "utf8")
				.split("\n")
				.find((line) => line.length > 0);
			const recordedId =
				firstLine === undefined
					? undefined
					: parseStationEvent(firstLine).stationId;
			const events = loadStationEvents(input.hoboHome, recordedId ?? dirName);
			const first = events[0];
			if (first !== undefined) {
				const realId = first.stationId;
				return {
					stationId: realId,
					client: createStationClient({
						hoboHome: input.hoboHome,
						stationId: realId,
					}),
				};
			}
		}
	}

	throw Object.assign(
		new Error(
			"no Station context: run `hobo station init` (or pass --station / HOBO_STATION / profile.defaultStation)",
		),
		{ code: "station-missing", remediation: "hobo station init" },
	);
}

/**
 * Cross-Station Connection use fails closed without an explicit federation grant.
 */
export function assertConnectionStationAccess(input: {
	readonly connectionStationId: string;
	readonly requestStationId: string;
	readonly federationGrant: boolean;
}): void {
	if (input.connectionStationId === input.requestStationId) return;
	if (input.federationGrant === true) return;
	throw Object.assign(
		new Error(
			`cross-Station Connection use denied (${input.connectionStationId} → ${input.requestStationId}); federation grant required`,
		),
		{ code: "connection-cross-station-denied" },
	);
}
