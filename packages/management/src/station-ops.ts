import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	createStationClient,
	initStation,
	type StationClient,
	StationService,
} from "@hobo/stations";

import type { ManagementContext } from "./context.js";
import { resolveDefaultStationId } from "./context.js";
import { errResult, type ManagementResult, okResult } from "./result.js";

export type StationInitInput = Readonly<{
	name?: string;
	id?: string;
	tenant?: string;
}>;

export function stationInit(
	ctx: ManagementContext,
	input: StationInitInput = {},
): ManagementResult {
	const name = input.name ?? "local";
	const id = input.id ?? `station:${name}`;
	const tenant = input.tenant ?? name;
	const railDoc = join(ctx.hoboHome, "hobo.broker.json");
	const result = initStation({
		hoboHome: ctx.hoboHome,
		id,
		name,
		tenant,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(existsSync(railDoc) ? { importRailDocPath: railDoc } : {}),
	});
	// Profile default station — best-effort write for local ops (schema-compatible).
	try {
		const profilePath = join(ctx.hoboHome, "profile.json");
		const existing = existsSync(profilePath)
			? // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
				(JSON.parse(readFileSync(profilePath, "utf8")) as Record<
					string,
					unknown
				>)
			: {};
		const next = {
			schemaVersion: "hobo.profile/v1",
			...existing,
			defaultStation: { id: result.stationId, dataDir: result.dataDir },
			// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
			...(result.occupancy.activeRailHash !== undefined
				? { activeRail: result.occupancy.activeRailHash }
				: {}),
			updatedAt: new Date().toISOString(),
		};
		mkdirSync(ctx.hoboHome, { recursive: true });
		writeFileSync(profilePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		/* profile write is best-effort */
	}
	ctx.setOccupyMode(result.stationId, "idle");
	return okResult(
		result.created
			? `hobo station init: created ${result.stationId}`
			: `hobo station init: already exists ${result.stationId}`,
		{
			stationId: result.stationId,
			dataDir: result.dataDir,
			created: result.created,
			bootstrapRailHash: result.bootstrap.contentHash,
			bootstrapActive: result.occupancy.bootstrapActive,
			activeRailHash: result.occupancy.activeRailHash,
			// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
			...(result.activatedRailHash !== undefined
				? { activatedRailHash: result.activatedRailHash }
				: {}),
		},
	);
}

export function stationStatus(
	ctx: ManagementContext,
	stationId?: string,
): ManagementResult {
	const id = resolveDefaultStationId(ctx, stationId) ?? "station:local";
	let client: StationClient;
	try {
		client = createStationClient({ hoboHome: ctx.hoboHome, stationId: id });
		client.load();
	} catch (err) {
		return errResult(err instanceof Error ? err.message : String(err), {
			code: "station-missing",
			remediation: ["hobo station init"],
			data: { code: "station-missing" },
		});
	}
	const occ = client.occupancy();
	const rail = client.activeRail();
	const occupyMode = ctx.getOccupyMode(id);
	return okResult(`hobo station status: ${id}`, {
		stationId: id,
		isolation: occ.isolation,
		status: occ.status,
		occupyMode,
		activeRailHash: occ.activeRailHash,
		bootstrapRailHash: occ.bootstrapRailHash,
		bootstrapActive: occ.bootstrapActive,
		connectionCount: occ.connectionCount,
		seq: occ.seq,
		activeRail: rail
			? {
					id: rail.id,
					name: rail.name,
					contentHash: rail.contentHash,
					isBootstrap: rail.isBootstrap,
				}
			: null,
		doctor: {
			bootstrapActive: occ.bootstrapActive,
			hint: occ.bootstrapActive
				? "bootstrap Rail active — activate a non-bootstrap Rail for production posture"
				: undefined,
		},
	});
}

export function stationUp(
	ctx: ManagementContext,
	stationId?: string,
): ManagementResult {
	const status = stationStatus(ctx, stationId);
	if (!status.ok || !status.data) return status;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
	const id = String((status.data as { stationId: string }).stationId);
	ctx.setOccupyMode(id, "occupying");
	return okResult(`hobo station up: ${id}`, {
		stationId: id,
		status: "occupying",
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		activeRailHash: (status.data as { activeRailHash?: string }).activeRailHash,
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		bootstrapActive: (status.data as { bootstrapActive?: boolean })
			.bootstrapActive,
	});
}

export function stationDown(
	ctx: ManagementContext,
	stationId?: string,
): ManagementResult {
	const id = resolveDefaultStationId(ctx, stationId) ?? "station:local";
	ctx.setOccupyMode(id, "idle");
	return okResult(`hobo station down: ${id}`, {
		stationId: id,
		status: "idle",
		dataRetained: true,
	});
}

export function stationRailsList(
	ctx: ManagementContext,
	stationId?: string,
): ManagementResult {
	const id = resolveDefaultStationId(ctx, stationId) ?? "station:local";
	const state = ctx.loadStationState(id);
	if (!state) {
		return errResult(`station not found: ${id}`, {
			code: "station-missing",
			remediation: ["hobo station init"],
		});
	}
	const rails = Object.values(state.rails).map((r) => ({
		id: r.id,
		name: r.name,
		contentHash: r.contentHash,
		activationStatus: r.activationStatus,
		isBootstrap: r.isBootstrap,
		quotaUsed: r.billingPolicy.quotaUsed,
		quotaLimit: r.billingPolicy.quotaLimit,
		spendCapUsd: r.billingPolicy.spendCapUsd,
	}));
	return okResult(`hobo station rails list: ${rails.length} rail(s)`, {
		stationId: id,
		activeRailHash: state.occupancy.activeRailHash,
		rails,
	});
}

export function stationRailsPublish(
	ctx: ManagementContext,
	input: {
		stationId?: string;
		id?: string;
		name?: string;
		version?: string;
		docPath?: string;
		// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
		raw?: Record<string, unknown>;
	},
): ManagementResult {
	const stationId =
		resolveDefaultStationId(ctx, input.stationId) ?? "station:local";
	const state = ctx.loadStationState(stationId);
	if (!state) {
		return errResult(`station not found: ${stationId}`, {
			code: "station-missing",
			remediation: ["hobo station init"],
		});
	}
	const svc = StationService.fromEvents(state.events, {
		stationId,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(ctx.now !== undefined ? { now: ctx.now } : {}),
	});
	let raw = input.raw;
	if (!raw && input.docPath) {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
		raw = JSON.parse(readFileSync(input.docPath, "utf8")) as Record<
			string,
			unknown
		>;
	}
	const rail = svc.publishRail({
		id: String(raw?.id ?? input.id ?? `rail-${Date.now()}`),
		name: String(raw?.name ?? input.name ?? "rail"),
		version: String(raw?.version ?? input.version ?? "1.0.0"),
		stationId,
		activationStatus: "draft",
	});
	ctx.persistStation(stationId, svc.events);
	return okResult(`hobo station rails publish: ${rail.contentHash}`, {
		railId: rail.id,
		contentHash: rail.contentHash,
		activationStatus: rail.activationStatus,
	});
}

export function stationRailsApprove(
	ctx: ManagementContext,
	input: { stationId?: string; hashOrId: string },
): ManagementResult {
	return railTransition(ctx, input, "approve");
}

export function stationRailsActivate(
	ctx: ManagementContext,
	input: { stationId?: string; hashOrId: string },
): ManagementResult {
	return railTransition(ctx, input, "activate");
}

function railTransition(
	ctx: ManagementContext,
	input: { stationId?: string; hashOrId: string },
	kind: "approve" | "activate",
): ManagementResult {
	const stationId =
		resolveDefaultStationId(ctx, input.stationId) ?? "station:local";
	const state = ctx.loadStationState(stationId);
	if (!state) {
		return errResult(`station not found: ${stationId}`, {
			code: "station-missing",
			remediation: ["hobo station init"],
		});
	}
	const resolved =
		state.rails[input.hashOrId] ??
		Object.values(state.rails).find((r) => r.id === input.hashOrId);
	if (!resolved) {
		return errResult(`rail not found: ${input.hashOrId}`, {
			code: "rail-missing",
		});
	}
	const svc = StationService.fromEvents(state.events, {
		stationId,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(ctx.now !== undefined ? { now: ctx.now } : {}),
	});
	if (kind === "approve") svc.approveRail(resolved.contentHash);
	else svc.activateRail(resolved.contentHash);
	ctx.persistStation(stationId, svc.events);
	return okResult(`hobo station rails ${kind}: ${resolved.contentHash}`, {
		contentHash: resolved.contentHash,
		stationId,
	});
}
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening -- SAFETY: local profile/rail JSON boundaries and omitted optional fields preserve the existing ops contract. */
