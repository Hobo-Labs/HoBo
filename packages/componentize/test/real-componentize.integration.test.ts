/**
 * Gated integration test for the D13 real componentize lane.
 *
 * Skips when @bytecodealliance/componentize-js is not importable (offline
 * floor). When it runs, it ACTUALLY componentizes a tiny JS source exporting a
 * wasi-cli-ish `health` function against the default inline WIT world.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	COMPONENT_MEDIA_TYPE,
	createRealComponentize,
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
		'export function health() {\n\treturn "hello-bindle:ok";\n}\n',
		"utf8",
	);
	return root;
}

describe.skipIf(!real.available)(
	"real componentize integration (componentize-js)",
	() => {
		it(
			"componentizes a tiny source into a real component-model binary",
			async () => {
				const sourceRoot = await writeSourceRoot();
				const result = await real.componentize({
					sourceRoot,
					sourceDateEpoch: SOURCE_DATE_EPOCH,
				});
				const bytes = result.component.bytes;

				// wasm magic
				expect(Array.from(bytes.subarray(0, 4))).toEqual([
					0x00, 0x61, 0x73, 0x6d,
				]);
				// component-model layer bytes (not a core module)
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
			},
			INTEGRATION_TIMEOUT,
		);

		it(
			"inputs contract is stable across two runs with the same sourceDateEpoch",
			async () => {
				const sourceRoot = await writeSourceRoot();
				const first = await real.componentize({
					sourceRoot,
					sourceDateEpoch: SOURCE_DATE_EPOCH,
				});
				const second = await real.componentize({
					sourceRoot,
					sourceDateEpoch: SOURCE_DATE_EPOCH,
				});

				// HONEST (ADR-0105, HOBO-603 spike, upstream ComponentizeJS#321):
				// componentize-js wasm BYTES are not byte-stable across builds — the
				// Wizer/StarlingMonkey snapshot varies even under pinned
				// SOURCE_DATE_EPOCH. The S0 determinism gate is therefore the inputs
				// contract (metadata) plus per-artifact digest integrity, not
				// byte-identical wasm. Verified empirically in this suite: asserting
				// digest equality here fails.
				expect(second.component.metadata).toBe(first.component.metadata);
				expect(first.component.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
				expect(second.component.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
				// Each run's OCI descriptor stays consistent with its own bytes.
				expect(first.oci.manifest.layers[0]?.digest).toBe(
					first.component.digest,
				);
				expect(second.oci.manifest.layers[0]?.digest).toBe(
					second.component.digest,
				);
			},
			INTEGRATION_TIMEOUT,
		);
	},
);
