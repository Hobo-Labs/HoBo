import {
	type DebugReplayLevel,
	type DebugReplayTrack,
	isDebugTrackEnvelope,
} from "./debug-replay.js";
import type { SessionBlobStore, SessionIndex } from "./storage.js";
import type { RrwebEvent, SessionRecord } from "./types.js";
import { ReplayParseError } from "./types.js";

export type DebugTimelineItem = Readonly<{
	sequence: number;
	timestamp: number;
	track: DebugReplayTrack;
	level: Exclude<DebugReplayLevel, "off">;
	metadata: Readonly<Record<string, unknown>>;
}>;

export type PlayerPayload = Readonly<{
	session: SessionRecord;
	events: readonly RrwebEvent[];
	debugTimeline: readonly DebugTimelineItem[];
	openUi: OpenUiPlayerDescriptor;
	deepLink: string;
}>;

export type OpenUiPlayerDescriptor = Readonly<{
	kind: "hobo.replay.player";
	version: "v1";
	sessionId: string;
	panels: readonly ("timeline" | "console" | "network" | "errors" | "flags")[];
	jumpTargets: readonly Readonly<{ label: string; timestamp: number }>[];
	controlYardZone: "session-replay";
	mutationSurface: "cli-only";
	readOnly: true;
}>;

export type ReplayEngine = {
	reconstruct(events: readonly RrwebEvent[]): Readonly<{
		ok: boolean;
		eventCount: number;
		durationMs: number;
	}>;
};

export function createFixtureReplayEngine(): ReplayEngine {
	return {
		reconstruct(events) {
			const timestamps = events.map((e) => e.timestamp);
			const min = timestamps.length ? Math.min(...timestamps) : 0;
			const max = timestamps.length ? Math.max(...timestamps) : 0;
			return Object.freeze({
				ok: events.length > 0,
				eventCount: events.length,
				durationMs: Math.max(0, max - min),
			});
		},
	};
}

export async function loadPlayerPayload(input: {
	readonly sessionId: string;
	readonly index: SessionIndex;
	readonly blobs: SessionBlobStore;
	readonly stationId: string;
	readonly requireStationMatch?: boolean;
	readonly blobRefs?: readonly string[];
}): Promise<PlayerPayload> {
	const session = await input.index.get(input.sessionId);
	if (!session) {
		throw new ReplayParseError(
			"replay-not-found",
			`session not found: ${input.sessionId}`,
		);
	}
	if (
		(input.requireStationMatch ?? true) &&
		session.correlation.stationId !== input.stationId
	) {
		throw new ReplayParseError(
			"REPLAY_STATION_BOUNDARY",
			`session ${input.sessionId} is not visible from ${input.stationId} without federation grant`,
		);
	}

	const events: RrwebEvent[] = [];
	const blobRefs =
		input.blobRefs ??
		(await input.index.listChunks(input.sessionId)).map(
			(chunk) => chunk.blobRef,
		);
	for (const ref of blobRefs) {
		const chunk = await input.blobs.get(ref);
		if (chunk) events.push(...chunk);
	}

	const jumpTargets: { label: string; timestamp: number }[] = [];
	const lastEvent = events.at(-1);
	if (session.correlation.errorId && lastEvent) {
		jumpTargets.push({
			label: `error:${session.correlation.errorId}`,
			timestamp: lastEvent.timestamp,
		});
	}
	const debugTimeline = Object.freeze(
		events
			.filter(isDebugTrackEnvelope)
			.map((event) =>
				Object.freeze({
					sequence: event.data.sequence,
					timestamp: event.timestamp,
					track: event.data.track,
					level: event.data.level,
					metadata: event.data.payload.metadata,
				}),
			)
			.sort((left, right) => left.sequence - right.sequence),
	);

	return Object.freeze({
		session,
		events: Object.freeze(events),
		debugTimeline,
		deepLink: `hobo://replay/open?session=${encodeURIComponent(session.id)}&station=${encodeURIComponent(input.stationId)}`,
		openUi: Object.freeze({
			kind: "hobo.replay.player" as const,
			version: "v1" as const,
			sessionId: session.id,
			panels: Object.freeze([
				"timeline" as const,
				"console" as const,
				"network" as const,
				"errors" as const,
				"flags" as const,
			]),
			jumpTargets: Object.freeze(jumpTargets),
			controlYardZone: "session-replay" as const,
			mutationSurface: "cli-only" as const,
			readOnly: true as const,
		}),
	});
}

export function summarizeSession(session: SessionRecord): string {
	const c = session.correlation;
	const parts = [
		`session ${session.id}`,
		`status=${session.status}`,
		`station=${c.stationId}`,
		`env=${c.env}`,
		`chunks=${session.chunkCount}`,
		`bytes=${session.totalBytes}`,
	];
	if (c.errorId) parts.push(`error=${c.errorId}`);
	if (c.trailId) parts.push(`trail=${c.trailId}`);
	if (c.principalRef) parts.push(`principal=${c.principalRef}`);
	if (c.harnessFlagKeys.length) {
		parts.push(`flags=${c.harnessFlagKeys.join(",")}`);
	}
	if (session.summary) parts.push(`note=${session.summary}`);
	return parts.join(" ");
}
