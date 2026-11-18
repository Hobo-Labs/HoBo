import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { catalogFactoryNames } from "../src/index.js";

it("documents a local-testing decision for every catalog resource kind", async () => {
	const readme = await readFile(
		new URL("../../testing/README.md", import.meta.url),
		"utf8",
	);
	const documented = [
		...readme.matchAll(
			/^\| `([^`]+)` \| `(port|http|fixture|placeholder|camp-only)` \|/gmu,
		),
	]
		.map((match) => match[1] ?? "")
		.sort();
	expect(documented).toEqual([...catalogFactoryNames()].sort());
});
