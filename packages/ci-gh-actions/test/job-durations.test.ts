import { expect, it } from "vitest";
import { createJobDurations } from "../src/job-durations.js";

const at = (seconds: number) =>
	new Date(Date.parse("2026-11-03T09:00:00Z") + seconds * 1000).toISOString();

function succeeded(id: number, name: string, seconds: number) {
	return {
		repository: "Org/Repo",
		id,
		name,
		conclusion: "success",
		startedAt: at(0),
		completedAt: at(seconds),
	};
}

it("expects a queued job to take the median of its name's last five successes", () => {
	const durations = createJobDurations();
	for (const [id, seconds] of [
		[1, 300],
		[2, 80],
		[3, 90],
		[4, 85],
		[5, 120],
		[6, 70],
	] as const)
		durations.observe(succeeded(id, "Main full gate", seconds));
	durations.observe({ repository: "org/repo", id: 7, name: "Main full gate" });
	// The 300 s outlier aged out of the window; 70, 80, 85, 90, 120 remain.
	expect(durations.expectedMs("Org/Repo", 7)).toBe(85_000);
	durations.observe(succeeded(8, "Main full gate", 95));
	expect(durations.expectedMs("Org/Repo", 7)).toBe(90_000);
});

it("counts each successful job once and ignores skipped, failed and unfinished runs", () => {
	const durations = createJobDurations();
	durations.observe(succeeded(1, "Secret scan", 10));
	durations.observe(succeeded(1, "Secret scan", 10));
	durations.observe(succeeded(2, "Secret scan", 20));
	durations.observe({
		...succeeded(3, "Secret scan", 0),
		conclusion: "skipped",
	});
	durations.observe({
		...succeeded(4, "Secret scan", 5),
		conclusion: "failure",
	});
	durations.observe({ ...succeeded(5, "Secret scan", 5), completedAt: null });
	durations.observe({ ...succeeded(6, "Secret scan", 5), startedAt: at(10) });
	durations.observe({ repository: "Org/Repo", id: 9, name: "Secret scan" });
	// Job 1 is one sample, not two: 10 and 20 give 15, not 10.
	expect(durations.expectedMs("Org/Repo", 9)).toBe(15_000);
});

it("expects nothing of a job it has no name or history for, or from another repository", () => {
	const durations = createJobDurations();
	durations.observe(succeeded(1, "Main full gate", 85));
	durations.observe({ repository: "Org/Repo", id: 2, name: "New job" });
	durations.observe({ repository: "Org/Repo", id: 3, name: "Main full gate" });
	expect(durations.expectedMs("Org/Repo", 2)).toBe(0);
	expect(durations.expectedMs("Org/Repo", 99)).toBe(0);
	expect(durations.expectedMs("Org/Other", 3)).toBe(0);
	expect(durations.expectedMs("org/repo", 3)).toBe(85_000);
});
