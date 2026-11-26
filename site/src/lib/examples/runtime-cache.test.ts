import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reuseVerifiedRuntime } from "../../../scripts/build-browser-wit-runtime.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) =>
			rm(root, { recursive: true, force: true }),
		),
	);
});

describe("browser WIT runtime cache", () => {
	it.each(["station.js", "station.core.wasm"])(
		"rejects a cache with tampered %s",
		async (tamperedAsset) => {
			const root = await mkdtemp(path.join(tmpdir(), "hobo-runtime-cache-"));
			temporaryRoots.push(root);
			const assets = {
				"station.component.wasm": new Uint8Array([0, 97, 115, 109]),
				"station.core.wasm": new Uint8Array([1, 2, 3]),
				"station.js": new TextEncoder().encode("export const ready = true;"),
			};
			const sourceDigest = digest(new TextEncoder().encode("guest source"));
			const buildDigest = digest(new TextEncoder().encode("build inputs"));
			const toolchain = { jco: "1.24.3", componentizeJs: "0.21.0", esbuild: "0.25.0" };
			await Promise.all(
				Object.entries(assets).map(([name, bytes]) =>
					writeFile(path.join(root, name), bytes),
				),
			);
			await writeFile(
				path.join(root, "manifest.json"),
				JSON.stringify({
					schemaVersion: "hobo.browser-wit-runtime/v1",
					componentDigest: digest(assets["station.component.wasm"]),
					sourceDigest,
					buildDigest,
					witWorld: "hobo:try/browser-station@0.1.0",
					entryModule: "station.js",
					toolchain,
					assets: Object.keys(assets),
					assetDigests: Object.fromEntries(
						Object.entries(assets).map(([name, bytes]) => [name, digest(bytes)]),
					),
				}),
			);

			expect(await reuseVerifiedRuntime(root, { sourceDigest, buildDigest, toolchain })).toBe(
				digest(assets["station.component.wasm"]),
			);
			const original = await readFile(path.join(root, tamperedAsset));
			await writeFile(path.join(root, tamperedAsset), Buffer.concat([original, Buffer.from([0])]));

			expect(await reuseVerifiedRuntime(root, { sourceDigest, buildDigest, toolchain })).toBeNull();
		},
	);

	it("rejects cache reuse when WIT or toolchain inputs drift", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "hobo-runtime-cache-"));
		temporaryRoots.push(root);
		const component = new Uint8Array([0, 97, 115, 109]);
		const station = new TextEncoder().encode("export const ready = true;");
		const sourceDigest = digest(new TextEncoder().encode("guest source"));
		const buildDigest = digest(new TextEncoder().encode("wit A"));
		const toolchain = { jco: "1.24.3", componentizeJs: "0.21.0", esbuild: "0.25.0" };
		await writeFile(path.join(root, "station.component.wasm"), component);
		await writeFile(path.join(root, "station.js"), station);
		await writeFile(
			path.join(root, "manifest.json"),
			JSON.stringify({
				schemaVersion: "hobo.browser-wit-runtime/v1",
				entryModule: "station.js",
				componentDigest: digest(component),
				sourceDigest,
				buildDigest,
				witWorld: "hobo:try/browser-station@0.1.0",
				toolchain,
				assets: ["station.component.wasm", "station.js"],
				assetDigests: {
					"station.component.wasm": digest(component),
					"station.js": digest(station),
				},
			}),
		);

		expect(
			await reuseVerifiedRuntime(root, {
				sourceDigest,
				buildDigest: digest(new TextEncoder().encode("wit B")),
				toolchain,
			}),
		).toBeNull();
		expect(
			await reuseVerifiedRuntime(root, {
				sourceDigest,
				buildDigest,
				toolchain: { ...toolchain, jco: "2.0.0" },
			}),
		).toBeNull();
	});
});

function digest(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
