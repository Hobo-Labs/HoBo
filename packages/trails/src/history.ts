/**
 * Durable applied Trail history per target environment (schema_migrations analog).
 */
import { createHash } from "node:crypto";
import type { TrailStep } from "./definition.js";

// public-contract: trail history schema.
export const TRAIL_HISTORY_SCHEMA = "hobo.trail-history/v1" as const;

export type TrailHistoryEntry = Readonly<{
	schemaVersion: typeof TRAIL_HISTORY_SCHEMA;
	trailId: string;
	trailVersion: string;
	stepId: string;
	target: string;
	tenant: string;
	/** Content checksum of the applied step definition. */
	checksum: `sha256:${string}`;
	appliedAt: string;
	status: "applied" | "baseline" | "repaired";
}>;

/**
 * In-memory history store (production projects fold trail.HistoryRecorded events).
 */
export class TrailHistoryStore {
	private readonly entries: TrailHistoryEntry[] = [];

	list(filter?: {
		readonly tenant?: string;
		readonly target?: string;
		readonly trailId?: string;
	}): readonly TrailHistoryEntry[] {
		return Object.freeze(
			this.entries.filter((e) => {
				if (filter?.tenant && e.tenant !== filter.tenant) return false;
				if (filter?.target && e.target !== filter.target) return false;
				if (filter?.trailId && e.trailId !== filter.trailId) return false;
				return true;
			}),
		);
	}

	isApplied(
		trailId: string,
		stepId: string,
		target: string,
		tenant: string,
	): boolean {
		return this.entries.some(
			(e) =>
				e.trailId === trailId &&
				e.stepId === stepId &&
				e.target === target &&
				e.tenant === tenant &&
				(e.status === "applied" || e.status === "baseline"),
		);
	}

	record(entry: Omit<TrailHistoryEntry, "schemaVersion">): TrailHistoryEntry {
		const full: TrailHistoryEntry = Object.freeze({
			schemaVersion: TRAIL_HISTORY_SCHEMA,
			...entry,
		});
		// Idempotent: same trail+step+target+tenant+checksum → no-op.
		const existing = this.entries.find(
			(e) =>
				e.trailId === full.trailId &&
				e.stepId === full.stepId &&
				e.target === full.target &&
				e.tenant === full.tenant,
		);
		if (existing) {
			if (existing.checksum !== full.checksum) {
				throw Object.assign(
					new Error(
						`trail history checksum mismatch for ${full.trailId}/${full.stepId}`,
					),
					{ code: "trail-history-checksum" },
				);
			}
			return existing;
		}
		this.entries.push(full);
		return full;
	}

	/** Mark existing state as applied without re-running (Sqitch/Flyway baseline). */
	baseline(
		entry: Omit<TrailHistoryEntry, "schemaVersion" | "status">,
	): TrailHistoryEntry {
		return this.record({ ...entry, status: "baseline" });
	}

	/** Repair a history row (new checksum after intentional fix). */
	repair(
		entry: Omit<TrailHistoryEntry, "schemaVersion" | "status">,
	): TrailHistoryEntry {
		const idx = this.entries.findIndex(
			(e) =>
				e.trailId === entry.trailId &&
				e.stepId === entry.stepId &&
				e.target === entry.target &&
				e.tenant === entry.tenant,
		);
		const full: TrailHistoryEntry = Object.freeze({
			schemaVersion: TRAIL_HISTORY_SCHEMA,
			...entry,
			status: "repaired",
		});
		if (idx >= 0) this.entries[idx] = full;
		else this.entries.push(full);
		return full;
	}
}

export function stepChecksum(step: TrailStep): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(JSON.stringify(step)).digest("hex")}`;
}
