import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentizeHelloBindle, PINNED_TOOLCHAIN } from "@hobo/componentize";
import { describe, expect, it } from "vitest";
import { defaultComponentize } from "../src/build/componentize-adapter.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"cli-componentize-boundary.pact.json",
);

const HELLO_BINDLE_FIXTURE = fileURLToPath(
	new URL("../../componentize/test/fixtures/hello-bindle", import.meta.url),
);

describe("CLI componentize boundary pact", () => {
	it("satisfies success and fail-closed interactions", async () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
			consumer: { name: string };
			provider: { name: string };
			interactions: Array<{
				response: { body: { component?: { mediaType: string } } };
			}>;
		};

		expect(pact.consumer.name).toBe("@hobo/cli");
		expect(pact.provider.name).toBe("@hobo/componentize");

		const success = await defaultComponentize({
			sourceRoot: HELLO_BINDLE_FIXTURE,
			sourceDateEpoch: "2026-01-01T00:00:00.000Z",
		});
		expect(success.component.mediaType).toBe(
			pact.interactions[0]?.response.body.component?.mediaType,
		);

		await expect(
			componentizeHelloBindle({
				sourceRoot: HELLO_BINDLE_FIXTURE,
				sourceDateEpoch: "2026-01-01T00:00:00.000Z",
				toolchain: { ...PINNED_TOOLCHAIN, jco: "1.24.4" },
			}),
		).rejects.toThrow(/componentize\.toolchain_skew/);
	});
});
