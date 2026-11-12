import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { pinnedContainerImages } from "../contracts/pinned-container-images.js";

// The pinned Postgres image (the Pact broker's database) is started by
// test/pinned-postgres-testcontainers.test.ts whenever a Docker engine is
// there.

it("compose.pact.yml uses the pinned-container-images catalog", async () => {
	const composePath = fileURLToPath(
		new URL("../contracts/compose.pact.yml", import.meta.url),
	);
	const text = await readFile(composePath, "utf8");
	for (const ref of Object.values(pinnedContainerImages)) {
		expect(text).toContain(ref);
	}
});
