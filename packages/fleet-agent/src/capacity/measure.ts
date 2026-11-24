import { readFile, statfs } from "node:fs/promises";
import { freemem } from "node:os";
import { create } from "@bufbuild/protobuf";
import {
	type Capacity,
	CapacitySchema,
	Health,
	type HostSignals,
} from "@hobo/fleet";

export const MEMORY_RESERVE_MB = 2_048;
const UINT32_MAX = 0xffff_ffff;
const MAX_SLOTS = 1_024;
const MEMINFO = "/proc/meminfo";
const MEMORY_PRESSURE = "/proc/pressure/memory";

export type HostCapacityOptions = Readonly<{
	slots: number;
	workRoot: string;
	labels: readonly string[];
}>;

export type VolumeFigures = Readonly<{
	freeDiskMb?: number;
	freeInodes?: number;
}>;

export type MemoryPressure = Readonly<{ some?: number; full?: number }>;

export type HostProbes = Readonly<{
	availableMemoryMb(): Promise<number | undefined>;
	volume(path: string): Promise<VolumeFigures>;
	memoryPressure(): Promise<MemoryPressure>;
}>;

export type HostReaders = Readonly<{
	platform: NodeJS.Platform;
	readFile(path: string): Promise<string>;
	statfs(
		path: string,
	): Promise<Readonly<{ bavail: number; bsize: number; ffree: number }>>;
	freemem(): number;
}>;

type HostSignalFigures = { -readonly [K in keyof HostSignals]: HostSignals[K] };

export type HostReading = Readonly<{
	capacity: Capacity;
	health: Health;
	labels: readonly string[];
	hostSignals: HostSignals;
}>;

export function parseAvailableMemoryMb(meminfo: string): number | undefined {
	const match = /^MemAvailable:[ \t]+(\d+)[ \t]+kB[ \t]*$/mu.exec(meminfo);
	if (match?.[1] === undefined) return undefined;
	const kilobytes = Number(match[1]);
	return Number.isSafeInteger(kilobytes)
		? Math.floor(kilobytes / 1024)
		: undefined;
}

function avg10(text: string, kind: "some" | "full"): number | undefined {
	const match = new RegExp(
		`^${kind} .*?\\bavg10=(\\d+(?:\\.\\d+)?)`,
		"mu",
	).exec(text);
	if (match?.[1] === undefined) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

export function parseMemoryPressure(text: string): MemoryPressure {
	const some = avg10(text, "some");
	const full = avg10(text, "full");
	if (some !== undefined && full !== undefined) return { some, full };
	if (some !== undefined) return { some };
	if (full !== undefined) return { full };
	return {};
}

const wholeMb = (bytes: number): number | undefined => {
	const megabytes = Math.floor(bytes / (1024 * 1024));
	return Number.isSafeInteger(megabytes) && megabytes >= 0
		? megabytes
		: undefined;
};
const count = (value: number): number | undefined =>
	Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function createHostProbes(readers: HostReaders): HostProbes {
	return Object.freeze({
		async availableMemoryMb() {
			if (readers.platform === "linux") {
				try {
					return parseAvailableMemoryMb(await readers.readFile(MEMINFO));
				} catch {
					return undefined;
				}
			}
			const bytes = readers.freemem();
			return Number.isFinite(bytes) && bytes >= 0 ? wholeMb(bytes) : undefined;
		},
		async volume(path: string): Promise<VolumeFigures> {
			try {
				const stats = await readers.statfs(path);
				const freeDiskMb = wholeMb(stats.bavail * stats.bsize);
				const freeInodes = count(stats.ffree);
				if (freeDiskMb !== undefined && freeInodes !== undefined)
					return { freeDiskMb, freeInodes };
				if (freeDiskMb !== undefined) return { freeDiskMb };
				if (freeInodes !== undefined) return { freeInodes };
				return {};
			} catch {
				return {};
			}
		},
		async memoryPressure(): Promise<MemoryPressure> {
			if (readers.platform !== "linux") return {};
			try {
				return parseMemoryPressure(await readers.readFile(MEMORY_PRESSURE));
			} catch {
				return {};
			}
		},
	} satisfies HostProbes);
}

export const NODE_READERS: HostReaders = Object.freeze({
	platform: process.platform,
	readFile: (path: string) => readFile(path, "utf8"),
	statfs: (path: string) => statfs(path),
	freemem,
});

export const HOST_PROBES: HostProbes = createHostProbes(NODE_READERS);

const uint32 = (value: number) => Math.min(Math.max(0, value), UINT32_MAX);

export function parseHostCapacityOptions(
	options: HostCapacityOptions,
): HostCapacityOptions {
	if (
		!Number.isInteger(options.slots) ||
		options.slots < 0 ||
		options.slots > MAX_SLOTS
	)
		throw new Error(
			`slots must be a whole number from 0 to ${MAX_SLOTS}, not ${options.slots}`,
		);
	if (options.workRoot === "") throw new Error("workRoot must be a path");
	for (const label of options.labels)
		if (label.trim() === "" || label.length > 128)
			throw new Error(`label "${label}" must be 1 to 128 characters`);
	return Object.freeze({
		slots: options.slots,
		workRoot: options.workRoot,
		labels: Object.freeze([...options.labels]),
	});
}

function hostSignals(
	volume: VolumeFigures,
	pressure: MemoryPressure,
): HostSignals {
	const signals: HostSignalFigures = {};
	if (volume.freeInodes !== undefined) signals.freeInodes = volume.freeInodes;
	if (pressure.some !== undefined) signals.psiMemorySome = pressure.some;
	if (pressure.full !== undefined) signals.psiMemoryFull = pressure.full;
	return Object.freeze(signals);
}

export async function readHostCapacity(
	options: HostCapacityOptions,
	probes: HostProbes,
): Promise<HostReading> {
	const [memoryMb, volume, pressure] = await Promise.all([
		probes.availableMemoryMb(),
		probes.volume(options.workRoot),
		probes.memoryPressure(),
	]);
	const spareMemoryMb =
		memoryMb === undefined
			? undefined
			: uint32(Math.floor(memoryMb - MEMORY_RESERVE_MB));
	return Object.freeze({
		capacity: create(CapacitySchema, {
			freeSlots: options.slots,
			totalSlots: options.slots,
			freeMemoryMb: spareMemoryMb,
			freeDiskMb:
				volume.freeDiskMb === undefined ? undefined : uint32(volume.freeDiskMb),
		}),
		health: spareMemoryMb === 0 ? Health.PRESSURED : Health.REACHABLE,
		labels: options.labels,
		hostSignals: hostSignals(volume, pressure),
	});
}
