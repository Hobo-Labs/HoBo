// Host capacity as the box worker measures it today (design §6.8; the worker's
// `free()` in isolated-worker-daemon-main.mts): memory is `MemAvailable` from
// /proc/meminfo less the worker's default 2 GiB host reserve, falling back to
// `os.freemem()` off Linux; disk is the space an unprivileged process may
// still take on the filesystem holding the work root (`statfs` bavail ×
// bsize). A figure that cannot be read is absent (unknown), never zero.
import { readFile, statfs } from "node:fs/promises";
import { freemem } from "node:os";
import { create } from "@bufbuild/protobuf";
import { type Capacity, CapacitySchema, Health } from "@hobo/fleet";

/** The worker's default `HOBO_CI_WORKER_MEMORY_RESERVE_MB`: memory never offered to work. */
export const MEMORY_RESERVE_MB = 2_048;
const UINT32_MAX = 0xffff_ffff;
const MAX_SLOTS = 1_024;

export type HostCapacityOptions = Readonly<{
	slots: number;
	workRoot: string;
	labels: readonly string[];
}>;

/** How a figure is read from the host; tests pass their own. */
export type HostProbes = Readonly<{
	availableMemoryMb(): Promise<number | undefined>;
	freeDiskMb(path: string): Promise<number | undefined>;
}>;

export type HostReading = Readonly<{
	capacity: Capacity;
	health: Health;
	labels: readonly string[];
}>;

export function parseAvailableMemoryMb(meminfo: string): number | undefined {
	const match = /^MemAvailable:[ \t]+(\d+)[ \t]+kB[ \t]*$/mu.exec(meminfo);
	if (match?.[1] === undefined) return undefined;
	const kilobytes = Number(match[1]);
	return Number.isSafeInteger(kilobytes)
		? Math.floor(kilobytes / 1024)
		: undefined;
}

async function availableMemoryMb(): Promise<number | undefined> {
	if (process.platform === "linux") {
		try {
			return parseAvailableMemoryMb(await readFile("/proc/meminfo", "utf8"));
		} catch {
			return undefined;
		}
	}
	const bytes = freemem();
	return Number.isFinite(bytes) && bytes >= 0
		? Math.floor(bytes / (1024 * 1024))
		: undefined;
}

async function freeDiskMb(path: string): Promise<number | undefined> {
	try {
		const stats = await statfs(path);
		const megabytes = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
		return Number.isSafeInteger(megabytes) && megabytes >= 0
			? megabytes
			: undefined;
	} catch {
		return undefined;
	}
}

export const HOST_PROBES: HostProbes = Object.freeze({
	availableMemoryMb,
	freeDiskMb,
});

const uint32 = (value: number) => Math.min(Math.max(0, value), UINT32_MAX);

/** Parses the options of createHostCapacity; throws, naming the field, when they are not usable. */
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

export async function readHostCapacity(
	options: HostCapacityOptions,
	probes: HostProbes,
): Promise<HostReading> {
	const [memoryMb, diskMb] = await Promise.all([
		probes.availableMemoryMb(),
		probes.freeDiskMb(options.workRoot),
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
			freeDiskMb: diskMb === undefined ? undefined : uint32(diskMb),
		}),
		health: spareMemoryMb === 0 ? Health.PRESSURED : Health.REACHABLE,
		labels: options.labels,
	});
}
