/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: assertions inspect known local-binding test fixtures. */
import { describe, expect, it } from "vitest";

import { attachCampToYard, camp, resolveLocalBindings } from "../src/index.js";

describe("resolveLocalBindings", () => {
	it("resolves when camp is attached to a local yard", async () => {
		const dev = camp("dev", { envType: "development" });
		const localCamp = attachCampToYard(dev, {
			yardId: "local",
			providerId: "local",
		});
		const env = await resolveLocalBindings(
			{
				schemaVersion: "hobo.wiring-manifest/v1",
				resources: {
					api: {
						kind: "api",
						name: "api",
						env: { PLAIN: "value" },
					},
				},
			} as never,
			localCamp,
			{
				async resolve() {
					return { value: "bound" };
				},
			} as never,
		);
		expect(env.PLAIN).toBe("value");
	});

	it("rejects non-local derived provider", async () => {
		const prod = attachCampToYard(camp("prod"), {
			yardId: "aws-prod",
			providerId: "aws",
		});
		await expect(
			resolveLocalBindings(
				{ schemaVersion: "hobo.wiring-manifest/v1", resources: {} } as never,
				prod,
				{
					async resolve() {
						return { value: "x" };
					},
				} as never,
			),
		).rejects.toThrow(/requires local provider/);
	});
});
