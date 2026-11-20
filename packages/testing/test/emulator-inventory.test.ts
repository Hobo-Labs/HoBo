import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createTestHarness } from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

it("keeps the documented resource support aligned with graph fidelity", async () => {
	const readme = await readFile(
		new URL("../README.md", import.meta.url),
		"utf8",
	);
	const entries = [
		...readme.matchAll(
			/^\| `([^`]+)` \| `(port|http|fixture|placeholder|camp-only)` \|/gmu,
		),
	].map((match) => ({ kind: match[1] ?? "", support: match[2] ?? "" }));
	expect(entries.length).toBeGreaterThan(0);
	const resources = Object.fromEntries(
		entries.map(({ kind }) => [kind, { kind }]),
	);
	const bindle = fakeBindle({ resources, handlers: {} });
	const harness = createTestHarness();
	const graph = await harness.deploy(bindle)();
	try {
		for (const { kind, support } of entries) {
			const expected =
				support === "port"
					? "simulated"
					: support === "camp-only"
						? "camp-only"
						: "mocked";
			expect(graph.resource(kind).fidelity, kind).toBe(expected);
		}
	} finally {
		await harness.destroy(bindle)();
	}
});
