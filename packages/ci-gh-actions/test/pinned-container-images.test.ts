import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { pinnedContainerImages } from "../contracts/pinned-container-images.js";

// The pinned Postgres image itself is started, and used, by the
// PostgresCiStore contract (test/ci-store-contract.test.ts, "Postgres
// engine"), which runs whenever a Docker engine is there.

it("compose.pact.yml uses the pinned-container-images catalog", async () => {
	const composePath = fileURLToPath(
		new URL("../contracts/compose.pact.yml", import.meta.url),
	);
	const text = await readFile(composePath, "utf8");
	for (const ref of Object.values(pinnedContainerImages)) {
		expect(text).toContain(ref);
	}
});
