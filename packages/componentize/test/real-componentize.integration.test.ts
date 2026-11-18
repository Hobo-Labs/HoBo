import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	COMPONENT_MEDIA_TYPE,
	createRealComponentize,
	runWasmtimeSmoke,
	validateRealWasmComponent,
} from "../src/index.js";

const SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";
const INTEGRATION_TIMEOUT = 300_000;

const real = await createRealComponentize();
const tempRoots: string[] = [];

afterAll(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
});

async function writeSourceRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hobo-real-componentize-it-"));
	tempRoots.push(root);
	const entry = join(root, "src/service.ts");
	await mkdir(dirname(entry), { recursive: true });
	await writeFile(
		entry,
		'export function health(): string {\n\treturn "hello-bindle:ok";\n}\n',
		"utf8",
	);
	return root;
}

describe("real componentize integration (componentize-js)", () => {
	it(
		"componentizes a tiny source into a real component-model binary",
		async () => {
			const sourceRoot = await writeSourceRoot();
			const result = await real.componentize({
				sourceRoot,
				sourceDateEpoch: SOURCE_DATE_EPOCH,
			});
			const bytes = result.component.bytes;

			expect(Array.from(bytes.subarray(0, 4))).toEqual([
				0x00, 0x61, 0x73, 0x6d,
			]);
			expect(bytes[6]).toBe(0x01);
			expect(bytes[7]).toBe(0x00);

			const summary = validateRealWasmComponent(bytes);
			expect(summary.format).toBe("wasm-component");
			expect(summary.byteLength).toBe(bytes.byteLength);

			expect(result.component.mediaType).toBe(COMPONENT_MEDIA_TYPE);
			expect(result.component.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(result.oci.manifest.layers[0]?.digest).toBe(
				result.component.digest,
			);

			const smoke = await runWasmtimeSmoke(result.component, {
				exportName: "health",
				timeoutMs: 120_000,
			});
			expect(smoke.engine).toBe("wasmtime@46.0.1");
			expect(smoke.stdout).toContain("hello-bindle:ok");
		},
		INTEGRATION_TIMEOUT,
	);

	it(
		"inputs contract is stable across two runs with the same sourceDateEpoch",
		async () => {
			const firstRoot = await writeSourceRoot();
			const secondRoot = await writeSourceRoot();
			const first = await real.componentize({
				sourceRoot: firstRoot,
				sourceDateEpoch: SOURCE_DATE_EPOCH,
			});
			const second = await real.componentize({
				sourceRoot: secondRoot,
				sourceDateEpoch: SOURCE_DATE_EPOCH,
			});

			expect(second.component.metadata).toBe(first.component.metadata);
			expect(first.component.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(second.component.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(first.oci.manifest.layers[0]?.digest).toBe(first.component.digest);
			expect(second.oci.manifest.layers[0]?.digest).toBe(
				second.component.digest,
			);
			const firstSmoke = await runWasmtimeSmoke(first.component, {
				exportName: "health",
				timeoutMs: 120_000,
			});
			const secondSmoke = await runWasmtimeSmoke(second.component, {
				exportName: "health",
				timeoutMs: 120_000,
			});
			expect(firstSmoke.stdout).toContain("hello-bindle:ok");
			expect(secondSmoke.stdout).toBe(firstSmoke.stdout);
		},
		INTEGRATION_TIMEOUT,
	);
});
