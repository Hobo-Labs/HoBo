import { readFileSync } from "node:fs";

export type HostCapacitySample = Readonly<{
	atMs: number;
	freeInodes: number;
	freeBytes: number;
	memAvailableMb?: number;
	psiMemorySome?: number;
	psiMemoryFull?: number;
}>;

export type HostCapacitySnapshot = Readonly<{
	observedFreeInodes: number;
	observedFreeBytes: number;
	memAvailableMb?: number;
	ourReservedInodes: number;
	safetyMarginInodes: number;
	externalInodeDrain?: number;
	admitNewWork: boolean;
	reason?: string;
}>;

export type HostCapacityTracker = Readonly<{
	record(sample: Omit<HostCapacitySample, "atMs">): void;
	marginInodes(): number;
	snapshot(ourReservedInodes: number): HostCapacitySnapshot;
	shouldBlockAdmission(): boolean;
	blockReason(): string | undefined;
}>;

export function parsePressureSome10(
	path: string,
): { some: number; full: number } | undefined {
	try {
		const text = readFileSync(path, "utf8");
		const line = text
			.split("\n")
			.find((entry) => entry.startsWith("some avg10="));
		if (!line) return undefined;
		const some = Number(line.match(/some avg10=([0-9.]+)/)?.[1]);
		const full = Number(line.match(/full avg10=([0-9.]+)/)?.[1]);
		if (!Number.isFinite(some) || !Number.isFinite(full)) return undefined;
		return { some, full };
	} catch {
		return undefined;
	}
}

export type HostCapacitySignals = Readonly<{
	memAvailableMb?: number;
	psiMemory?: Readonly<{ some: number; full: number }>;
}>;

export function readHostCapacitySignals(
	meminfoPath = "/proc/meminfo",
): HostCapacitySignals {
	let memAvailableMb: number | undefined;
	try {
		const match = /^MemAvailable:[ \t]+(\d+)[ \t]+kB/mu.exec(
			readFileSync(meminfoPath, "utf8"),
		);
		if (match?.[1]) {
			const kb = Number(match[1]);
			if (Number.isSafeInteger(kb)) memAvailableMb = Math.floor(kb / 1024);
		}
	} catch {
		memAvailableMb = undefined;
	}
	const psiMemory = parsePressureSome10("/proc/pressure/memory");
	return buildHostCapacitySignals(memAvailableMb, psiMemory);
}

export function buildHostCapacityRecord(
	freeInodes: number,
	freeBytes: number,
	signals: HostCapacitySignals,
): Omit<HostCapacitySample, "atMs"> {
	if (
		signals.memAvailableMb !== undefined &&
		signals.psiMemory !== undefined
	)
		return {
			freeInodes,
			freeBytes,
			memAvailableMb: signals.memAvailableMb,
			psiMemorySome: signals.psiMemory.some,
			psiMemoryFull: signals.psiMemory.full,
		};
	if (signals.memAvailableMb !== undefined)
		return {
			freeInodes,
			freeBytes,
			memAvailableMb: signals.memAvailableMb,
		};
	if (signals.psiMemory !== undefined)
		return {
			freeInodes,
			freeBytes,
			psiMemorySome: signals.psiMemory.some,
			psiMemoryFull: signals.psiMemory.full,
		};
	return { freeInodes, freeBytes };
}

function buildHostCapacitySignals(
	memAvailableMb: number | undefined,
	psiMemory: Readonly<{ some: number; full: number }> | undefined,
): HostCapacitySignals {
	if (memAvailableMb !== undefined && psiMemory !== undefined)
		return { memAvailableMb, psiMemory };
	if (memAvailableMb !== undefined) return { memAvailableMb };
	if (psiMemory !== undefined) return { psiMemory };
	return {};
}

function buildHostCapacitySnapshot(input: {
	freeInodes: number;
	freeBytes: number;
	ourReservedInodes: number;
	safetyMarginInodes: number;
	admitNewWork: boolean;
	memAvailableMb: number | undefined;
	externalInodeDrain: number | undefined;
	blockReason: string | undefined;
}): HostCapacitySnapshot {
	if (
		input.memAvailableMb !== undefined &&
		input.externalInodeDrain !== undefined &&
		input.blockReason !== undefined
	)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			memAvailableMb: input.memAvailableMb,
			externalInodeDrain: input.externalInodeDrain,
			reason: input.blockReason,
		};
	if (
		input.memAvailableMb !== undefined &&
		input.externalInodeDrain !== undefined
	)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			memAvailableMb: input.memAvailableMb,
			externalInodeDrain: input.externalInodeDrain,
		};
	if (input.memAvailableMb !== undefined && input.blockReason !== undefined)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			memAvailableMb: input.memAvailableMb,
			reason: input.blockReason,
		};
	if (input.externalInodeDrain !== undefined && input.blockReason !== undefined)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			externalInodeDrain: input.externalInodeDrain,
			reason: input.blockReason,
		};
	if (input.memAvailableMb !== undefined)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			memAvailableMb: input.memAvailableMb,
		};
	if (input.externalInodeDrain !== undefined)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			externalInodeDrain: input.externalInodeDrain,
		};
	if (input.blockReason !== undefined)
		return {
			observedFreeInodes: input.freeInodes,
			observedFreeBytes: input.freeBytes,
			ourReservedInodes: input.ourReservedInodes,
			safetyMarginInodes: input.safetyMarginInodes,
			admitNewWork: input.admitNewWork,
			reason: input.blockReason,
		};
	return {
		observedFreeInodes: input.freeInodes,
		observedFreeBytes: input.freeBytes,
		ourReservedInodes: input.ourReservedInodes,
		safetyMarginInodes: input.safetyMarginInodes,
		admitNewWork: input.admitNewWork,
	};
}

export function createHostCapacityTracker(options: {
	now?: () => number;
	windowMs?: number;
	minInodeMargin?: number;
	maxInodeMargin?: number;
	psiSomeBlock?: number;
	psiFullBlock?: number;
	maxSamples?: number;
}): HostCapacityTracker {
	const now = options.now ?? Date.now;
	const windowMs = options.windowMs ?? 120_000;
	const minInodeMargin = options.minInodeMargin ?? 25_000;
	const maxInodeMargin = options.maxInodeMargin ?? 250_000;
	const psiSomeBlock = options.psiSomeBlock ?? 25;
	const psiFullBlock = options.psiFullBlock ?? 5;
	const maxSamples = options.maxSamples ?? 64;
	const samples: HostCapacitySample[] = [];
	let blocked = false;
	let blockReason: string | undefined;

	function prune(atMs: number) {
		while (samples.length > 0) {
			const head = samples[0];
			if (!head || atMs - head.atMs <= windowMs) break;
			samples.shift();
		}
		if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
	}

	function volatilityMargin(): number {
		if (samples.length < 2) return minInodeMargin;
		let maxDrop = 0;
		for (let index = 1; index < samples.length; index++) {
			const prev = samples[index - 1];
			const current = samples[index];
			if (!prev || !current) continue;
			maxDrop = Math.max(
				maxDrop,
				Math.max(0, prev.freeInodes - current.freeInodes),
			);
		}
		const scaled = Math.ceil(maxDrop * 1.5);
		return Math.min(maxInodeMargin, Math.max(minInodeMargin, scaled));
	}

	function record(sample: Omit<HostCapacitySample, "atMs">) {
		const atMs = now();
		prune(atMs);
		samples.push({ ...sample, atMs });
		blocked = false;
		blockReason = undefined;
		if (
			sample.psiMemoryFull !== undefined &&
			sample.psiMemoryFull >= psiFullBlock
		) {
			blocked = true;
			blockReason = "psi-memory-full";
		} else if (
			sample.psiMemorySome !== undefined &&
			sample.psiMemorySome >= psiSomeBlock
		) {
			blocked = true;
			blockReason = "psi-memory-some";
		}
	}

	return {
		record,
		marginInodes: volatilityMargin,
		shouldBlockAdmission: () => blocked,
		blockReason: () => blockReason,
		snapshot(ourReservedInodes: number): HostCapacitySnapshot {
			const latest = samples.at(-1);
			const margin = volatilityMargin();
			const freeInodes = latest?.freeInodes ?? 0;
			const earliest = samples[0];
			const externalInodeDrain =
				earliest && latest
					? Math.max(0, earliest.freeInodes - latest.freeInodes)
					: undefined;
			const admitNewWork = !blocked;
			return buildHostCapacitySnapshot({
				freeInodes,
				freeBytes: latest?.freeBytes ?? 0,
				ourReservedInodes,
				safetyMarginInodes: margin,
				admitNewWork,
				memAvailableMb: latest?.memAvailableMb,
				externalInodeDrain,
				blockReason,
			});
		},
	};
}
