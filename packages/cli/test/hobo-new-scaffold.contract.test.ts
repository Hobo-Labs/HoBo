import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scaffoldHoboProject } from "../src/index.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"hobo-new-scaffold.pact.json",
);

describe("hobo new scaffold pact", () => {
	it("scaffolds offline projects matching the boundary contract", async () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
			interactions: Array<{
				response: { body: { offline: boolean; createdFiles: string[] } };
			}>;
		};
		const expectedFiles =
			pact.interactions[0]?.response.body.createdFiles ?? [];

		const cwd = await mkdtemp(path.join(tmpdir(), "hobo-cli-pact-"));
		try {
			const result = await scaffoldHoboProject({
				cwd,
				name: "snapshop" as never,
				template: "api",
			});

			expect(result.offline).toBe(pact.interactions[0]?.response.body.offline);
			expect(result.createdFiles).toEqual(expectedFiles);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
