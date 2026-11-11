import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { WorkerStorageReserve } from "./storage-job-classes.js";

const MAX_SAMPLES = 20;
const jobPeaksSchema = z
	.object({
		workRootBytes: z.array(z.number().int().nonnegative()).max(MAX_SAMPLES),
		workRootInodes: z.array(z.number().int().nonnegative()).max(MAX_SAMPLES),
		dockerDataRootBytes: z
			.array(z.number().int().nonnegative())
			.max(MAX_SAMPLES)
			.optional(),
		dockerDataRootInodes: z
			.array(z.number().int().nonnegative())
			.max(MAX_SAMPLES)
			.optional(),
	})
	.strict();
const storagePeaksFileSchema = z.record(z.string().min(1), jobPeaksSchema);

export type StoragePeakHistory = Readonly<{
	workRootBytes: readonly number[];
	workRootInodes: readonly number[];
	dockerDataRootBytes?: readonly number[];
	dockerDataRootInodes?: readonly number[];
}>;
export type StoragePeakHistories = Readonly<Record<string, StoragePeakHistory>>;

export type StoragePeaksLog = (
	event: "hobo_ci_storage_peaks_reset" | "hobo_ci_storage_peaks_write_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

function ceilWithMargin(
	peak: number,
	margin = 1.25,
	floor = 256 * 1024 * 1024,
) {
	return Math.ceil(Math.max(floor, peak * margin));
}

/**
 * Blend class budgets with measured workdir peaks (Docker layer stays on class caps).
 */
export function learnedStorageReserve(
	history: StoragePeakHistory | undefined,
	classReserve: WorkerStorageReserve,
	unmeasuredScale = 0.65,
): WorkerStorageReserve {
	if (!history || history.workRootBytes.length < 3) {
		return {
			workRoot: Math.ceil(classReserve.workRoot * unmeasuredScale),
			dockerDataRoot: Math.ceil(classReserve.dockerDataRoot * unmeasuredScale),
			workRootBytes: Math.ceil(classReserve.workRootBytes * unmeasuredScale),
			dockerDataRootBytes: Math.ceil(
				classReserve.dockerDataRootBytes * unmeasuredScale,
			),
		};
	}
	const peakWorkBytes = Math.max(...history.workRootBytes);
	const peakWorkInodes = Math.max(...history.workRootInodes);
	const workRootBytes = Math.min(
		classReserve.workRootBytes,
		ceilWithMargin(peakWorkBytes),
	);
	const workRootInodes = Math.min(
		classReserve.workRoot,
		Math.ceil(peakWorkInodes * 1.2),
	);
	let dockerDataRootBytes = classReserve.dockerDataRootBytes;
	let dockerDataRoot = classReserve.dockerDataRoot;
	if (history.dockerDataRootBytes && history.dockerDataRootBytes.length >= 3) {
		const peakDocker = Math.max(...history.dockerDataRootBytes);
		dockerDataRootBytes = Math.min(
			classReserve.dockerDataRootBytes,
			ceilWithMargin(peakDocker, 1.15),
		);
	}
	if (
		history.dockerDataRootInodes &&
		history.dockerDataRootInodes.length >= 3
	) {
		const peakDockerInodes = Math.max(...history.dockerDataRootInodes);
		dockerDataRoot = Math.min(
			classReserve.dockerDataRoot,
			Math.ceil(peakDockerInodes * 1.2),
		);
	}
	return {
		workRoot: workRootInodes,
		dockerDataRoot,
		workRootBytes,
		dockerDataRootBytes,
	};
}

export function createStoragePeaks(options: {
	path: string;
	log?: StoragePeaksLog;
}) {
	const history: Record<string, StoragePeakHistory> = {};
	try {
		const input: unknown = JSON.parse(readFileSync(options.path, "utf8"));
		Object.assign(history, storagePeaksFileSchema.parse(input));
	} catch (error) {
		options.log?.("hobo_ci_storage_peaks_reset", {
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
			options.log?.("hobo_ci_storage_peaks_write_failed", {
				path: options.path,
				message: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	return {
		history,
		record(
			jobName: string,
			sample: Readonly<{
				workRootBytes: number;
				workRootInodes: number;
				dockerDataRootBytes?: number;
				dockerDataRootInodes?: number;
			}>,
		): void {
			if (!jobName) throw new Error("invalid storage peak job name");
			for (const value of [
				sample.workRootBytes,
				sample.workRootInodes,
				sample.dockerDataRootBytes ?? 0,
				sample.dockerDataRootInodes ?? 0,
			]) {
				if (!Number.isInteger(value) || value < 0)
					throw new Error("invalid storage peak sample");
			}
			const previous = history[jobName];
			const next: StoragePeakHistory = {
				workRootBytes: [
					...(previous?.workRootBytes ?? []),
					sample.workRootBytes,
				].slice(-MAX_SAMPLES),
				workRootInodes: [
					...(previous?.workRootInodes ?? []),
					sample.workRootInodes,
				].slice(-MAX_SAMPLES),
			};
			const recorded = {
				workRootBytes: [...next.workRootBytes],
				workRootInodes: [...next.workRootInodes],
				...(sample.dockerDataRootBytes !== undefined
					? {
							dockerDataRootBytes: [
								...(previous?.dockerDataRootBytes ?? []),
								sample.dockerDataRootBytes,
							].slice(-MAX_SAMPLES),
						}
					: previous?.dockerDataRootBytes === undefined
						? {}
						: { dockerDataRootBytes: [...previous.dockerDataRootBytes] }),
				...(sample.dockerDataRootInodes !== undefined
					? {
							dockerDataRootInodes: [
								...(previous?.dockerDataRootInodes ?? []),
								sample.dockerDataRootInodes,
							].slice(-MAX_SAMPLES),
						}
					: previous?.dockerDataRootInodes === undefined
						? {}
						: {
								dockerDataRootInodes: [...previous.dockerDataRootInodes],
							}),
			} satisfies StoragePeakHistory;
			history[jobName] = recorded;
			persist();
		},
	};
}

export type StoragePeaks = ReturnType<typeof createStoragePeaks>;

export function resolvedStorageReserve(
	_jobName: string,
	history: StoragePeakHistory | undefined,
	classReserve: WorkerStorageReserve,
): WorkerStorageReserve {
	return learnedStorageReserve(history, classReserve);
}
