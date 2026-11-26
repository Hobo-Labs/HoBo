import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadToolchainLock, parseToolchainLock } from "../src/index.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const LOCK_PATH = join(PACKAGE_ROOT, "wit-lock.json");

async function listWitFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listWitFiles(path)));
			continue;
		}
		if (entry.name.endsWith(".wit")) {
			files.push(path);
		}
	}
	return files;
}

function digestFile(contents: string): string {
	return `sha256:${createHash("sha256").update(contents.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}

describe("toolchain lock", () => {
	it("pins every vendored WIT file with a matching digest", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const witRoot = join(PACKAGE_ROOT, "wit");
		const witFiles = await listWitFiles(witRoot);

		for (const absolutePath of witFiles) {
			const relativePath = absolutePath.slice(`${PACKAGE_ROOT}/`.length);
			const source = await readFile(absolutePath, "utf8");
			const expectedDigest = digestFile(source);
			const pins = lock.witDeps.filter((dep) => dep.path === relativePath);
			expect(pins.length, `${relativePath} missing lock pin`).toBeGreaterThan(
				0,
			);
			for (const pin of pins) {
				expect(pin.sha256).toBe(expectedDigest);
			}
		}
	});

	it("rejects tampered digests at the parser boundary", () => {
		const raw = {
			schema: "hobo.wit-toolchain-lock/v1",
			package: "hobo:sdk@0.1.0",
			canonical_generator: {
				name: "@bytecodealliance/jco",
				version: "1.24.3",
				role: "canonical-ts-bindings",
			},
			compat_floor: {
				wasmtime: "46.0.1",
				componentize_js: "0.21.0",
				wrpc: "0.17.0",
				wasm_cloud: "2.4.0",
			},
			wit_deps: [
				{
					id: "hobo:runtime/workflow@0.1.0@experimental",
					namespace: "hobo",
					package_name: "runtime",
					interface_name: "workflow",
					version: "0.1.0",
					stability: "experimental",
					path: "wit/deps/hobo-runtime/hobo-runtime.wit",
					sha256:
						"sha256:0000000000000000000000000000000000000000000000000000000000000000",
				},
			],
			guards: [],
		};

		expect(() => parseToolchainLock(raw)).not.toThrow();
		expect(() =>
			parseToolchainLock({
				...raw,
				wit_deps: [{ ...raw.wit_deps[0], sha256: "sha256:deadbeef" }],
			}),
		).toThrow(/sha256/);
	});
});
