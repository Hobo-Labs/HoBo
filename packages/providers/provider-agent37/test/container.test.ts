import { describe, expect, it } from "vitest";
import { startFakeAgent37Server } from "../src/fake/container.js";

describe("Agent37 fake container startup", () => {
	it("requires explicit opt-in for an in-process fallback", async () => {
		const previous = process.env.HOBO_FUZZ_DOCKER;
		process.env.HOBO_FUZZ_DOCKER = "0";
		try {
			await expect(startFakeAgent37Server()).rejects.toThrow(
				"allowInProcessFallback",
			);
			await expect(
				startFakeAgent37Server({
					requireContainer: true,
					allowInProcessFallback: true,
				}),
			).rejects.toThrow("docker-required");
			const started = await startFakeAgent37Server({
				allowInProcessFallback: true,
			});
			try {
				expect(started.mode).toBe("in-process");
				expect(started.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
			} finally {
				await started.close();
			}
		} finally {
			if (previous === undefined) delete process.env.HOBO_FUZZ_DOCKER;
			else process.env.HOBO_FUZZ_DOCKER = previous;
		}
	});
});
