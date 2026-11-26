import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { bootstrap, workflow } from "../src/_generated-assets/relay-assets.js";

it("bundles the exact reviewed GitHub Actions host files", async () => {
	expect(workflow).toBe(
		await readFile(
			new URL(
				"../../ci-gh-actions/templates/hobo-ci-host.yml",
				import.meta.url,
			),
			"utf8",
		),
	);
	expect(bootstrap).toBe(
		await readFile(
			new URL("../../ci-gh-actions/src/bootstrap.ts", import.meta.url),
			"utf8",
		),
	);
});
