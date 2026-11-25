import { type Capacity, Health, Refusal } from "../_generated/fleet_pb.js";
import type { CapacitySource, HostSignals } from "../ports.js";

export type CapacityReading = Awaited<ReturnType<CapacitySource["read"]>>;

export const STORAGE_FLOOR_DISK_MB = 8_192;
export const STORAGE_FLOOR_INODES = 25_000;
export const PSI_MEMORY_SOME_LIMIT = 25;
export const PSI_MEMORY_FULL_LIMIT = 5;

export type { HostSignals } from "../ports.js";

type HostSignalFigures = { -readonly [K in keyof HostSignals]: HostSignals[K] };

export type RefusalInput = Readonly<{
	draining: boolean;
	health: Health | undefined;
	capacity: Capacity | undefined;
	host?: HostSignals;
}>;

const under = (value: number | undefined, floor: number) =>
	value !== undefined && value < floor;
const atLeast = (value: number | undefined, limit: number) =>
	value !== undefined && value >= limit;

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
	return capacity.totalSlots === 0 ? Refusal.UNSPECIFIED : Refusal.OWN_WORK;
}

export function publishedHealth(
	refusal: Refusal,
	health: Health | undefined,
): Health {
	if (refusal === Refusal.DRAINING) return Health.DRAINING;
	if (refusal === Refusal.STORAGE || refusal === Refusal.PRESSURE)
		return Health.PRESSURED;
	return health ?? Health.UNKNOWN;
}

function figure(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

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
