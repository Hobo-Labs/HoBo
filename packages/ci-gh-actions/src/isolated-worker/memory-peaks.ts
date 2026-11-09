import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_SAMPLES = 20;
const OOM_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const jobPeaksSchema = z
	.object({
		peaksMb: z.array(z.number().int().positive()).max(MAX_SAMPLES),
		oomAt: z.string().datetime({ offset: true }).optional(),
	})
	.strict();
const memoryPeaksFileSchema = z.record(z.string().min(1), jobPeaksSchema);

export type MemoryPeakHistory = Readonly<{
	peaksMb: readonly number[];
	oomAt?: string;
}>;
export type MemoryPeakHistories = Readonly<Record<string, MemoryPeakHistory>>;
type MemoryPeakHistoryDraft = {
	peaksMb: number[];
	oomAt?: string;
};
export type MemoryPeaksLog = (
	event: "hobo_ci_memory_peaks_reset" | "hobo_ci_memory_peaks_write_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export function learnedReservationMb(
	history: MemoryPeakHistory | undefined,
	classMb: number,
	unmeasuredMb = classMb,
	now = Date.now(),
): number {
	if (
		history?.oomAt !== undefined &&
		Date.parse(history.oomAt) >= now - OOM_WINDOW_MS
	)
		return classMb;
	if (!history || history.peaksMb.length < 3) return unmeasuredMb;
	const peakMb = Math.max(...history.peaksMb);
	const reservationMb = Math.ceil((peakMb * 1.25 + 256) / 256) * 256;
	return Math.min(classMb, Math.max(1_024, reservationMb));
}

export function createMemoryPeaks(options: {
	path: string;
	log?: MemoryPeaksLog;
	now?: () => string;
}) {
	const now = options.now ?? (() => new Date().toISOString());
	const history: Record<string, MemoryPeakHistory> = {};
	try {
		const input: unknown = JSON.parse(readFileSync(options.path, "utf8"));
		Object.assign(history, memoryPeaksFileSchema.parse(input));
	} catch (error) {
		options.log?.("hobo_ci_memory_peaks_reset", {
			path: options.path,
			message: error instanceof Error ? error.message : "unknown",
		});
	}

	function persist(): void {
		try {
			mkdirSync(dirname(options.path), { recursive: true });
			const temporary = `${options.path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(history)}\n`, {
				mode: 0o600,
			});
			renameSync(temporary, options.path);
		} catch (error) {
			options.log?.("hobo_ci_memory_peaks_write_failed", {
				path: options.path,
				message: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	return {
		history,
		record(jobName: string, peakMb: number): void {
			if (!jobName || !Number.isInteger(peakMb) || peakMb < 1)
				throw new Error("invalid container memory peak");
			const previous = history[jobName];
			const next: MemoryPeakHistoryDraft = {
				peaksMb: [...(previous?.peaksMb ?? []), peakMb].slice(-MAX_SAMPLES),
			};
			if (previous?.oomAt !== undefined) next.oomAt = previous.oomAt;
			history[jobName] = next;
			persist();
		},
		recordOom(jobName: string): void {
			if (!jobName) return;
			history[jobName] = { peaksMb: [], oomAt: now() };
			persist();
		},
	};
}

export type MemoryPeaks = ReturnType<typeof createMemoryPeaks>;
