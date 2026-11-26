/**
 * Perceptual statistics from an asciicast v2 recording.
 *
 * These are the numbers that make "feel" falsifiable: time-to-first-output,
 * silent gaps (frozen UI), and output byte volume (repaint thrash). They land
 * in evidence meta.json as `timing` / `frameStats` so `evidenceChecks` can
 * assert them like exit codes.
 */

export type CastStats = {
	/** Output events in the recording. */
	readonly eventCount: number;
	/** Total bytes across output events. */
	readonly totalOutputBytes: number;
	/** ms until the first output event. */
	readonly firstOutputMs: number | null;
	/** Longest gap between consecutive output events (ms). */
	readonly maxSilentGapMs: number | null;
	/** Timestamp of the last event (ms) — recording duration proxy. */
	readonly durationMs: number | null;
};

/** Parse an asciicast v2 text (header line + one JSON event per line). */
export function analyzeCast(text: string): CastStats | null {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return null;
	let header: unknown;
	try {
		header = JSON.parse(lines[0]!);
	} catch {
		return null;
	}
	if (
		!header ||
		typeof header !== "object" ||
		(header as { version?: number }).version !== 2
	) {
		return null;
	}
	let eventCount = 0;
	let totalOutputBytes = 0;
	let firstOutputMs: number | null = null;
	let maxSilentGapMs: number | null = null;
	let prevMs: number | null = null;
	let lastMs: number | null = null;
	for (const line of lines.slice(1)) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!Array.isArray(event) || event.length < 3) continue;
		const [t, type, data] = event as [number, string, string];
		if (typeof t !== "number") continue;
		const ms = t * 1000;
		lastMs = ms;
		if (type !== "o") continue;
		eventCount += 1;
		totalOutputBytes += Buffer.byteLength(String(data), "utf8");
		if (firstOutputMs === null) firstOutputMs = ms;
		if (prevMs !== null) {
			const gap = ms - prevMs;
			if (maxSilentGapMs === null || gap > maxSilentGapMs) {
				maxSilentGapMs = gap;
			}
		}
		prevMs = ms;
	}
	return {
		eventCount,
		totalOutputBytes,
		firstOutputMs: firstOutputMs === null ? null : Math.round(firstOutputMs),
		maxSilentGapMs: maxSilentGapMs === null ? null : Math.round(maxSilentGapMs),
		durationMs: lastMs === null ? null : Math.round(lastMs),
	};
}
