import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BindleImportError, loadBindleDefinition } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("loadBindleDefinition", () => {
	it("returns null when no bindle source exists", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-loader-empty-"));
		roots.push(dir);
		await expect(loadBindleDefinition(dir)).resolves.toBeNull();
	});

	it("loads a try-site-style app.js bindle (catalog convention)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-loader-app-"));
		roots.push(dir);
		await writeFile(
			path.join(dir, "app.js"),
			'export default { name: "try-app", resources: { web: { kind: "web", annotations: [] } }, edges: [] };\n',
		);
		const definition = await loadBindleDefinition(dir);
		expect(definition).not.toBeNull();
	});

	it("prefers src/bindle over app.* when both exist", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-loader-order-"));
		roots.push(dir);
		await mkdir(path.join(dir, "src"), { recursive: true });
		await writeFile(
			path.join(dir, "src", "bindle.js"),
			'export default { name: "from-bindle", resources: {}, edges: [] };\n',
		);
		await writeFile(
			path.join(dir, "app.js"),
			'export default { name: "from-app", resources: {}, edges: [] };\n',
		);
		const definition = await loadBindleDefinition(dir);
		// SAFETY: `expect((definition as { name: string }).name).toBe("from-bindle");` is required at this I/O or test boundary.
		expect((definition as { name: string }).name).toBe("from-bindle");
	});

	it("surfaces a missing workspace dependency instead of no_bindle", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-loader-miss-"));
		roots.push(dir);
		await mkdir(path.join(dir, "src"), { recursive: true });
		await writeFile(
			path.join(dir, "src", "bindle.js"),
			'import { honoEntrypoint } from "@hobo/adapter-hono";\nexport default { name: "x" };\n',
		);
		await expect(loadBindleDefinition(dir)).rejects.toBeInstanceOf(
			BindleImportError,
		);
		await expect(loadBindleDefinition(dir)).rejects.toThrow(
			/adapter-hono|Cannot find/u,
		);
	});
});
