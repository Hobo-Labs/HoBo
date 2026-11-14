/**
 * Why a member admits no new work (amendment 4, D60; ADR-0181 R4), derived
 * once, here, from the agent's state, its capacity reading and the host
 * signals that reading carries. `fleetVerdict` tells `BUSY` from
 * `NO_CAPACITY` by it.
 *
 * Thresholds are the ones main's box worker uses (L43):
 * - storage: fewer than 8 GiB free under the work root (`storage-admission.ts`,
 *   the default job's `workRootBytes` reserve) or fewer than 25,000 free
 *   inodes (`host-capacity.ts`, `minInodeMargin`);
 * - pressure: no memory left above the 2 GiB host reserve (L10,
 *   `free_memory_mb == 0`), a source that reports `PRESSURED`, or memory PSI
 *   avg10 at or over 25 ("some") or 5 ("full") (`host-capacity.ts`,
 *   `psiSomeBlock`/`psiFullBlock`).
 *
 * An absent figure is unknown and never crosses a threshold.
 */
import { type Capacity, Health, Refusal } from "../_generated/fleet_pb.js";
import type { CapacitySource, HostSignals } from "../ports.js";

/** What a `CapacitySource` reads. */
export type CapacityReading = Awaited<ReturnType<CapacitySource["read"]>>;

/** Free MiB under the work root below which no new work is admitted. */
export const STORAGE_FLOOR_DISK_MB = 8_192;
/** Free inodes on the work volume below which no new work is admitted. */
export const STORAGE_FLOOR_INODES = 25_000;
/** Memory PSI "some" avg10 (percent) at or over which no new work is admitted. */
export const PSI_MEMORY_SOME_LIMIT = 25;
/** Memory PSI "full" avg10 (percent) at or over which no new work is admitted. */
export const PSI_MEMORY_FULL_LIMIT = 5;

/**
 * Host figures a capacity reading may carry (`CapacitySource` amendment 6;
 * `@hobo/fleet-agent`'s `createHostCapacity` fills them); absent means unknown.
 */
export type { HostSignals } from "../ports.js";

/** `HostSignals` while it is being filled in. */
type HostSignalFigures = { -readonly [K in keyof HostSignals]: HostSignals[K] };

export type RefusalInput = Readonly<{
	draining: boolean;
	/** The capacity source's health; undefined when the read failed. */
	health: Health | undefined;
	/** Capacity after this member's own running work; undefined when unknown. */
	capacity: Capacity | undefined;
	host?: HostSignals;
}>;

const under = (value: number | undefined, floor: number) =>
	value !== undefined && value < floor;
const atLeast = (value: number | undefined, limit: number) =>
	value !== undefined && value >= limit;

/** DRAINING, then STORAGE, then PRESSURE, then OWN_WORK; NONE when work is admitted. */
export function deriveRefusal(input: RefusalInput): Refusal {
	if (input.draining) return Refusal.DRAINING;
	const { capacity, host = {} } = input;
	if (
		under(capacity?.freeDiskMb, STORAGE_FLOOR_DISK_MB) ||
		under(host.freeInodes, STORAGE_FLOOR_INODES)
	)
		return Refusal.STORAGE;
	if (
		input.health === Health.PRESSURED ||
		capacity?.freeMemoryMb === 0 ||
		atLeast(host.psiMemorySome, PSI_MEMORY_SOME_LIMIT) ||
		atLeast(host.psiMemoryFull, PSI_MEMORY_FULL_LIMIT)
	)
		return Refusal.PRESSURE;
	if (capacity === undefined) return Refusal.UNSPECIFIED;
	if (capacity.freeSlots > 0) return Refusal.NONE;
	// A member configured with no slots is not busy with anything.
	return capacity.totalSlots === 0 ? Refusal.UNSPECIFIED : Refusal.OWN_WORK;
}

/** The health a member publishes beside its refusal: refusing for the host makes it `PRESSURED`, so no dispatcher fits work to it. */
export function publishedHealth(
	refusal: Refusal,
	health: Health | undefined,
): Health {
	if (refusal === Refusal.DRAINING) return Health.DRAINING;
	if (refusal === Refusal.STORAGE || refusal === Refusal.PRESSURE)
		return Health.PRESSURED;
	return health ?? Health.UNKNOWN;
}

/** A figure the agent can use: finite and not negative. */
function figure(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/** The `hostSignals` a capacity reading carries, keeping only usable figures. */
export function hostSignalsOf(
	reading: CapacityReading | undefined,
): HostSignals {
	const raw = reading?.hostSignals;
	if (raw === undefined) return {};
	const signals: HostSignalFigures = {};
	const freeInodes = figure(raw.freeInodes);
	if (freeInodes !== undefined) signals.freeInodes = freeInodes;
	const some = figure(raw.psiMemorySome);
	if (some !== undefined) signals.psiMemorySome = some;
	const full = figure(raw.psiMemoryFull);
	if (full !== undefined) signals.psiMemoryFull = full;
	return signals;
}
