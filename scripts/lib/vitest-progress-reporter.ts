import { relative } from "node:path";
import type { Reporter } from "vitest/node";

const SLOWEST_COUNT = 10;
const PAUSE_REPORT_MS = 10_000;

// The slices of Vitest's objects this reporter reads; Vitest's own types satisfy them.
type ReporterHost = {
	readonly config: { readonly root: string };
	readonly logger: { log(message: string): void };
};
type StartedModule = { readonly moduleId: string };
type FinishedModule = StartedModule & {
	diagnostic(): { readonly duration: number };
};

export type RunningFile = { readonly file: string; readonly ageMs: number };

export function formatHeartbeat(
	done: number,
	total: number,
	running: readonly RunningFile[],
): string {
	const files = [...running]
		.sort((a, b) => b.ageMs - a.ageMs)
		.map(({ file, ageMs }) => `${file} (${Math.round(ageMs / 1000)}s)`);
	return `vitest progress: ${done}/${total} files done; running: ${files.join(", ") || "none"}`;
}

export function formatSlowest(
	files: readonly { readonly file: string; readonly durationMs: number }[],
	count = SLOWEST_COUNT,
): string {
	const lines = [...files]
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, count)
		.map(
			({ file, durationMs }) =>
				`  ${(durationMs / 1000).toFixed(1).padStart(6)}s  ${file}`,
		);
	return [`vitest slowest files (of ${files.length}):`, ...lines].join("\n");
}

/**
 * Names the files a quiet CI run is spending its time in: a heartbeat lists the
 * files still running and their age, and the run ends with the slowest files.
 * A heartbeat that arrives late on the wall clock but not on the monotonic one
 * marks a host pause at that point in the log.
 */
export default class ProgressReporter implements Reporter {
	private readonly started = new Map<string, number>();
	private readonly intervalMs: number;
	private root = process.cwd();
	private total = 0;
	private done = 0;
	private timer: NodeJS.Timeout | undefined;
	private lastWall = 0;
	private lastMonotonic = 0;
	private log: (message: string) => void = console.log;

	constructor(options: { readonly intervalMs?: number } = {}) {
		this.intervalMs =
			options.intervalMs ??
			Number(process.env.HOBO_TEST_HEARTBEAT_MS ?? 30_000);
	}

	onInit(vitest: ReporterHost): void {
		this.root = vitest.config.root;
		this.log = (message) => vitest.logger.log(message);
	}

	onTestRunStart(specifications: { readonly length: number }): void {
		this.total = specifications.length;
		this.lastWall = Date.now();
		this.lastMonotonic = performance.now();
		this.timer = setInterval(() => this.heartbeat(), this.intervalMs);
		this.timer.unref();
	}

	onTestModuleStart(testModule: StartedModule): void {
		this.started.set(testModule.moduleId, performance.now());
	}

	onTestModuleEnd(testModule: StartedModule): void {
		this.started.delete(testModule.moduleId);
		this.done += 1;
	}

	onTestRunEnd(testModules: readonly FinishedModule[]): void {
		clearInterval(this.timer);
		this.log(
			formatSlowest(
				testModules.map((testModule) => ({
					file: relative(this.root, testModule.moduleId),
					durationMs: testModule.diagnostic().duration,
				})),
			),
		);
		if (this.started.size > 0) this.heartbeat();
	}

	private heartbeat(): void {
		const wall = Date.now();
		const monotonic = performance.now();
		const pausedMs = wall - this.lastWall - (monotonic - this.lastMonotonic);
		this.lastWall = wall;
		this.lastMonotonic = monotonic;
		if (pausedMs > PAUSE_REPORT_MS) {
			this.log(
				`vitest progress: the host was paused for about ${Math.round(pausedMs / 1000)}s since the last heartbeat (wall clock ran ahead of the monotonic clock)`,
			);
		}
		this.log(
			formatHeartbeat(
				this.done,
				this.total,
				[...this.started].map(([id, start]) => ({
					file: relative(this.root, id),
					ageMs: monotonic - start,
				})),
			),
		);
	}
}
