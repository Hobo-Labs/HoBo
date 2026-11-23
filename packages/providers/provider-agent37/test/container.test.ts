import { startFakeAgent37Server } from "@hobo/provider-agent37/fake/container";
import { describe, expect, it } from "vitest";

describe("Agent37 fake container startup", () => {
	it("requires explicit fallback and serves HTTP in fallback mode", async () => {
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
				const response = await fetch(`${started.baseUrl}/v1/instances`, {
					headers: { authorization: `Bearer ${started.apiKey}` },
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ instances: [] });
			} finally {
				await started.close();
			}
		} finally {
			if (previous === undefined) delete process.env.HOBO_FUZZ_DOCKER;
			else process.env.HOBO_FUZZ_DOCKER = previous;
		}
	});
});
