import type { ManagementContext } from "./context.js";
import { resolveDefaultStationId } from "./context.js";
import { errResult, type ManagementResult, okResult } from "./result.js";
import {
	type ConnectorActivityView,
	type DoctorView,
	type MeteringView,
	toPublicConnection,
	toRailPublicView,
	type YardProjectionSnapshot,
} from "./types.js";

type DoctorData = {
	bootstrapActive: boolean;
	hazards: readonly string[];
	hint?: string;
};

/**
 * Fold Station + Connection stores into a single Yard snapshot for the game UI.
 * Never invents occupancy/rail/connection state outside event-sourced services.
 */
export function projectYardSnapshot(
	ctx: ManagementContext,
	input: { stationId?: string; tenant?: string } = {},
): ManagementResult<YardProjectionSnapshot> {
	const stationId = resolveDefaultStationId(ctx, input.stationId);
	if (!stationId) {
		// SAFETY: this failure result is returned through the typed yard projection API.
		return errResult("station required for yard projection", {
			code: "station-missing",
			remediation: ["hobo station init"],
		}) as ManagementResult<YardProjectionSnapshot>;
	}
	const state = ctx.loadStationState(stationId);
	if (!state) {
		// SAFETY: this failure result is returned through the typed yard projection API.
		return errResult(`station not found: ${stationId}`, {
			code: "station-missing",
			remediation: ["hobo station init"],
		}) as ManagementResult<YardProjectionSnapshot>;
	}

	const actor = ctx.resolveActor();
	const tenant =
		input.tenant ?? actor.tenant ?? state.occupancy.isolation.tenant;
	const connections = ctx
		.loadConnectionService(tenant)
		.list()
		.filter((c) => c.stationId === stationId)
		.map(toPublicConnection);

	const rails = Object.values(state.rails).map(toRailPublicView);
	const activeRail = state.occupancy.activeRailHash
		? state.rails[state.occupancy.activeRailHash]
		: undefined;

	// Domain status after authorize is "active" (not "authorized").
	const authorized = connections.filter((c) => c.status === "active");
	const metering: MeteringView = Object.freeze({
		quotaUsed: activeRail?.billingPolicy.quotaUsed ?? 0,
		quotaLimit: activeRail?.billingPolicy.quotaLimit ?? 0,
		spendCapUsd: activeRail?.billingPolicy.spendCapUsd ?? 0,
		budgetUsd: activeRail?.billingPolicy.budgetUsd ?? 0,
		trafficRate: Math.min(
			1,
			authorized.length * 0.25 + (authorized.length > 0 ? 0.15 : 0),
		),
		// Provenance badge (HIGHBALL "kill or badge"): this rate is synthesized
		// from connection counts, not measured traffic. Flips to "otlp" when
		// real metering signals feed the projection.
		trafficRateSource: "synthetic",
	});

	const activity: ConnectorActivityView[] = connections.map((c) =>
		Object.freeze({
			connectorKind: mapProviderToConnectorKind(c.provider),
			status: mapConnectionStatusToActivity(String(c.status)),
			connectionId: c.id,
			// Provenance badge: status is statically derived from the connection
			// lifecycle, not live agent telemetry.
			statusSource: "derived-static",
		}),
	);

	const hazards: string[] = [];
	if (state.occupancy.bootstrapActive) {
		hazards.push("bootstrap-rail-active");
	}
	if (state.occupancy.status === "closed") {
		hazards.push("station-closed");
	}
	for (const c of connections) {
		if (c.status === "revoked") hazards.push(`connection-revoked:${c.id}`);
	}

	const doctorData: DoctorData = {
		bootstrapActive: state.occupancy.bootstrapActive,
		hazards: Object.freeze([...hazards]),
	};
	if (state.occupancy.bootstrapActive)
		doctorData.hint =
			"bootstrap Rail active — activate a non-bootstrap Rail for production posture";
	const doctor: DoctorView = Object.freeze(doctorData);

	const snap: YardProjectionSnapshot = Object.freeze({
		occupancy: state.occupancy,
		rails: Object.freeze(rails),
		connections: Object.freeze(connections),
		metering,
		activity: Object.freeze(activity),
		doctor,
		seq: state.occupancy.seq,
		occupyMode: ctx.getOccupyMode(stationId),
	});

	return okResult(`yard snapshot ${stationId} seq=${snap.seq}`, snap);
}

function mapProviderToConnectorKind(provider: string): string {
	const p = provider.toLowerCase();
	if (p.includes("claude")) return "swe-claude";
	if (p.includes("grok")) return "swe-grok";
	if (p.includes("codex")) return "swe-codex";
	if (p.includes("cursor")) return "swe-cursor";
	if (p.includes("gemini")) return "swe-gemini";
	if (p.includes("copilot")) return "swe-copilot";
	return provider;
}

function mapConnectionStatusToActivity(
	status: string,
): ConnectorActivityView["status"] {
	switch (status) {
		case "active":
			return "working";
		case "pending":
		case "needs-reauth":
			return "idle";
		case "revoked":
		case "expired":
			return "error";
		default:
			return "offline";
	}
}

export function brokerStatus(
	ctx: ManagementContext,
	input: { stationId?: string } = {},
): ManagementResult {
	const stationId = resolveDefaultStationId(ctx, input.stationId);
	if (!stationId) {
		return okResult("broker status: no default station", {
			ok: false,
			message: "no station — run hobo station init",
		});
	}
	const state = ctx.loadStationState(stationId);
	if (!state) {
		return okResult("broker status: station missing", {
			ok: false,
			stationId,
			message: "station missing — run hobo station init",
		});
	}
	return okResult(`broker status: ${stationId}`, {
		ok: true,
		stationId,
		activeRailHash: state.occupancy.activeRailHash,
		bootstrapActive: state.occupancy.bootstrapActive,
		connectionCount: state.occupancy.connectionCount,
		status: state.occupancy.status,
		message: "ok",
	});
}

export function doctorSnapshot(
	ctx: ManagementContext,
	input: { stationId?: string } = {},
): ManagementResult {
	const yard = projectYardSnapshot(ctx, input);
	if (!yard.ok || !yard.data) return yard;
	return okResult("doctor", {
		stationId: yard.data.occupancy.stationId,
		doctor: yard.data.doctor,
		seq: yard.data.seq,
	});
}
