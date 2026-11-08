import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createMemoryPeaks,
	learnedReservationMb,
} from "../src/isolated-worker/memory-peaks.js";

const NOW = Date.parse("2026-11-04T12:00:00Z");

describe("learnedReservationMb", () => {
	it.each([
		{ name: "no samples", history: undefined, expected: 6_144 },
		{
			name: "two samples",
			history: { peaksMb: [1_000, 1_000] },
			expected: 6_144,
		},
		{
			name: "three samples and 256 MiB rounding",
			history: { peaksMb: [800, 1_000, 900] },
			expected: 1_536,
		},
		{
			name: "recent OOM",
			history: {
				peaksMb: [1_000, 1_000, 1_000],
				oomAt: "2026-11-01T12:00:00Z",
			},
			expected: 6_144,
		},
		{
			name: "expired OOM",
			history: {
				peaksMb: [1_000, 1_000, 1_000],
				oomAt: "2026-10-20T12:00:00Z",
			},
			expected: 1_536,
		},
		{
			name: "floor clamp",
			history: { peaksMb: [1, 2, 3] },
			expected: 1_024,
		},
		{
			name: "class clamp",
			history: { peaksMb: [5_000, 5_000, 5_000] },
			expected: 6_144,
		},
	])("$name", ({ history, expected }) => {
		expect(learnedReservationMb(history, 6_144, 6_144, NOW)).toBe(expected);
	});

	it("uses the unmeasured reserve below the sample threshold", () => {
		expect(
			learnedReservationMb({ peaksMb: [100, 100] }, 6_144, 4_096, NOW),
		).toBe(4_096);
	});

	it("keeps the class size for an unmeasured job with a recent OOM", () => {
		expect(
			learnedReservationMb(
				{ peaksMb: [], oomAt: "2026-11-01T12:00:00Z" },
				6_144,
				4_096,
				NOW,
			),
		).toBe(6_144);
	});
});

describe("memory peak persistence", () => {
	it("round-trips history and caps each job at the last 20 samples", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-memory-peaks-"));
		try {
			const path = join(directory, "state", "memory-peaks.json");
			const peaks = createMemoryPeaks({ path });
			for (let peakMb = 1; peakMb <= 22; peakMb += 1)
				peaks.record("PR impact gate", peakMb);
			peaks.record("Secret scan", 512);

			const reopened = createMemoryPeaks({ path });
			expect(reopened.history["PR impact gate"]?.peaksMb).toEqual(
				Array.from({ length: 20 }, (_, index) => index + 3),
			);
			expect(reopened.history["Secret scan"]?.peaksMb).toEqual([512]);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				"PR impact gate": {
					peaksMb: Array.from({ length: 20 }, (_, index) => index + 3),
				},
				"Secret scan": { peaksMb: [512] },
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("treats a corrupt file as empty history and logs once", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-memory-peaks-corrupt-"));
		try {
			const path = join(directory, "memory-peaks.json");
			writeFileSync(path, "not json");
			const log = vi.fn();
			const peaks = createMemoryPeaks({ path, log });
			expect(peaks.history).toEqual({});
			expect(log).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith(
				"hobo_ci_memory_peaks_reset",
				expect.objectContaining({ path }),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("clears samples and persists the OOM timestamp", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-memory-peaks-oom-"));
		try {
			const path = join(directory, "memory-peaks.json");
			const peaks = createMemoryPeaks({
				path,
				now: () => "2026-11-04T12:00:00Z",
			});
			peaks.record("PR impact gate", 1_000);
			peaks.record("PR impact gate", 1_100);
			peaks.record("PR impact gate", 1_200);
			peaks.recordOom("PR impact gate");

			expect(createMemoryPeaks({ path }).history["PR impact gate"]).toEqual({
				peaksMb: [],
				oomAt: "2026-11-04T12:00:00Z",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
