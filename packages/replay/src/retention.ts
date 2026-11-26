/**
 * Retention / GC / erasure recipes for session data.
 * Composes with Trails as platform recipe `replay.retention` (documented).
 */
import { createReplayEvent, REPLAY_EVENTS } from "./events.js";
import type { SessionIndex } from "./storage.js";
import type { SessionRecord } from "./types.js";

// public-contract: platform recipe id for Trails composition.
export const REPLAY_RETENTION_RECIPE = "replay.retention" as const;

export type RetentionPolicy = Readonly<{
	/** Max age in days for ended sessions before GC. */
	maxAgeDays: number;
	/** Right-to-erasure: drop blobs + mark erased. */
	eraseOnRequest: boolean;
	/** Isolation classes that keep longer (audit). */
	retainIsolationClasses?: readonly string[];
}>;

export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({
	maxAgeDays: 30,
	eraseOnRequest: true,
	retainIsolationClasses: Object.freeze(["production"]),
});

export type RetentionResult = Readonly<{
	scanned: number;
	erased: number;
	retained: number;
	events: readonly ReturnType<typeof createReplayEvent>[];
}>;

export async function applyRetention(input: {
	readonly index: SessionIndex;
	readonly stationId: string;
	readonly policy?: RetentionPolicy;
	readonly now?: Date;
	readonly eraseBlob?: (sessionId: string) => Promise<void>;
}): Promise<RetentionResult> {
	const policy = input.policy ?? DEFAULT_RETENTION;
	const now = input.now ?? new Date();
	const sessions = await input.index.list({ stationId: input.stationId });
	const events: ReturnType<typeof createReplayEvent>[] = [];
	let erased = 0;
	let retained = 0;
	let seq = 0;

	for (const session of sessions) {
		if (session.status === "erased") {
			retained += 1;
			continue;
		}
		const ended = session.endedAt ?? session.startedAt;
		const ageMs = now.getTime() - Date.parse(ended);
		const ageDays = ageMs / (1000 * 60 * 60 * 24);
		const keepLonger = policy.retainIsolationClasses?.includes(
			session.correlation.isolationClass,
		);
		const max = keepLonger ? policy.maxAgeDays * 2 : policy.maxAgeDays;

		if (ageDays > max) {
			await eraseSession(input.index, session, input.eraseBlob);
			erased += 1;
			events.push(
				createReplayEvent(REPLAY_EVENTS.RetentionApplied, {
					sessionId: session.id,
					stationId: input.stationId,
					seq: seq++,
					data: {
						action: "gc",
						ageDays: Math.floor(ageDays),
						recipe: REPLAY_RETENTION_RECIPE,
					},
				}),
			);
		} else {
			retained += 1;
		}
	}

	return Object.freeze({
		scanned: sessions.length,
		erased,
		retained,
		events: Object.freeze(events),
	});
}

export async function eraseSessionById(input: {
	readonly index: SessionIndex;
	readonly sessionId: string;
	readonly stationId: string;
	readonly eraseBlob?: (sessionId: string) => Promise<void>;
}): Promise<SessionRecord | undefined> {
	const session = await input.index.get(input.sessionId);
	if (!session) return undefined;
	if (session.correlation.stationId !== input.stationId) {
		throw Object.assign(
			new Error("cannot erase session from foreign station"),
			{ code: "REPLAY_STATION_BOUNDARY" },
		);
	}
	return eraseSession(input.index, session, input.eraseBlob);
}

async function eraseSession(
	index: SessionIndex,
	session: SessionRecord,
	eraseBlob?: (sessionId: string) => Promise<void>,
): Promise<SessionRecord> {
	await eraseBlob?.(session.id);
	const erased: SessionRecord = Object.freeze({
		...session,
		status: "erased" as const,
		chunkCount: 0,
		totalBytes: 0,
		summary: "erased",
	});
	await index.upsert(erased);
	return erased;
}

/**
 * Trail-composition descriptor (not a new control-plane noun).
 * Apps compose `replay.retention` via existing Trails recipes.
 */
export function replayRetentionTrailStep(): Readonly<{
	id: string;
	kind: "replay-retention";
	recipe: typeof REPLAY_RETENTION_RECIPE;
	description: string;
}> {
	return Object.freeze({
		id: "replay-retention-gc",
		kind: "replay-retention" as const,
		recipe: REPLAY_RETENTION_RECIPE,
		description:
			"GC / erasure of session-replay blobs under privacy + cost policy",
	});
}
