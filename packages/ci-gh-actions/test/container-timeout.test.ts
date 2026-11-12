import { describe, expect, it } from "vitest";
import {
	capIsolatedContainerTimeoutMs,
	containerPastHardTimeout,
	MAX_ISOLATED_JOB_TIMEOUT_MS,
	parseContainerTimeoutMs,
	parseDockerCreatedAtMs,
} from "../src/isolated-worker/container-timeout.js";

describe("isolated container timeout", () => {
	it("parses timeout labels and docker timestamps", () => {
		expect(parseContainerTimeoutMs({ "hobo.ci/timeout-ms": "3900000" })).toBe(
			3_900_000,
		);
		expect(parseContainerTimeoutMs({ "hobo.ci/timeout-ms": "x" })).toBe(
			undefined,
		);
		expect(parseDockerCreatedAtMs("2026-11-09 10:00:00 +0000 UTC")).toBe(
			Date.parse("2026-11-09T10:00:00.000Z"),
		);
	});

	it("caps isolated job timeout labels at twenty minutes", () => {
		expect(capIsolatedContainerTimeoutMs(65 * 60_000)).toBe(
			MAX_ISOLATED_JOB_TIMEOUT_MS,
		);
		expect(capIsolatedContainerTimeoutMs(15 * 60_000)).toBe(15 * 60_000);
	});

	it("flags containers past budget plus hard grace", () => {
		const created = Date.parse("2026-11-09T10:00:00.000Z");
		const budget = 65 * 60_000;
		const grace = 5 * 60_000;
		expect(
			containerPastHardTimeout(created, budget, created + budget + grace - 1),
		).toBe(false);
		expect(
			containerPastHardTimeout(created, budget, created + budget + grace),
		).toBe(true);
	});
});
