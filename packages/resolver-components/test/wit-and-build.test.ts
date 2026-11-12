// The WIT world matches the host's constants, and the componentize recipe
// is deterministic on the synthetic lane and fails closed on the real lane.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentizeToolchainError } from "@hobo/componentize";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildResolverComponent,
	componentizeResolver,
	componentizeResolverReal,
	RESOLVER_CONTRACT_SECTION,
} from "../src/build/index.js";
import {
	RESOLVER_OPERATIONS,
	RESOLVER_WIT_PACKAGE,
	RESOLVER_WIT_WORLD,
	wasmDigestOf,
} from "../src/index.js";
import { manifestJson } from "./fixtures.js";

const wit = readFileSync(
	new URL("../wit/resolver.wit", import.meta.url),
	"utf8",
);

describe("hobo:resolver@0.1.0 WIT", () => {
	it("declares the package and world the host loads", () => {
		expect(wit).toContain(`package ${RESOLVER_WIT_PACKAGE};`);
		expect(RESOLVER_WIT_WORLD).toBe("hobo:resolver/resolver-component@0.1.0");
		expect(wit).toMatch(
			/world resolver-component \{[^}]*import wasi:http\/outgoing-handler@0\.2\.0;[^}]*import host;[^}]*export resolver;/su,
		);
	});

	it("exports exactly the five resolver operations", () => {
		const resolver = /interface resolver \{(.*?)\n\}/su.exec(wit)?.[1] ?? "";
		const operations = [...resolver.matchAll(/^\s*([a-z-]+): func/gmu)].map(
			(match) => match[1],
		);
		expect(operations).toEqual([...RESOLVER_OPERATIONS]);
	});

	it("host imports carry a credential locator, never material", () => {
		expect(wit).toMatch(
			/authorized-fetch: func\(request: http-request, credential-ref: string\)/u,
		);
		const code = wit
			.split("\n")
			.filter((line) => !line.trim().startsWith("///"))
			.join("\n");
		expect(code).not.toMatch(/secret|password|token/iu);
	});
});

describe("componentize build recipe", () => {
	it("emits a valid wasm module with the contract section, deterministically", () => {
		const bytes = componentizeResolver({
			componentId: "c",
			version: "1.0.0",
			source: "guest",
		});
		expect(WebAssembly.validate(bytes)).toBe(true);
		const module = new WebAssembly.Module(bytes);
		const [section] = WebAssembly.Module.customSections(
			module,
			RESOLVER_CONTRACT_SECTION,
		);
		const metadata = JSON.parse(
			Buffer.from(section ?? new ArrayBuffer(0)).toString("utf8"),
		);
		expect(metadata.world).toBe(RESOLVER_WIT_WORLD);
		expect(metadata.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(wasmDigestOf(bytes)).toBe(
			wasmDigestOf(
				componentizeResolver({
					componentId: "c",
					version: "1.0.0",
					source: "guest",
				}),
			),
		);
	});

	it("stamps the bytes' digest into the manifest and derives the digest to sign", () => {
		const bytes = componentizeResolver({
			componentId: "acme-static",
			version: "1.2.3",
			source: "x",
		});
		const built = buildResolverComponent(manifestJson(), bytes);
		expect(built.manifest.wasmDigest).toBe(wasmDigestOf(bytes));
		expect(built.registryDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("the real lane fails closed when the toolchain is missing", async () => {
		// An empty temporary source root: the lane must refuse before it reads it.
		const sourceRoot = mkdtempSync(join(tmpdir(), "resolver-real-lane-"));
		afterAll(() => rmSync(sourceRoot, { recursive: true, force: true }));
		await expect(
			componentizeResolverReal(
				{
					sourceRoot,
					sourceDateEpoch: "2026-01-01T00:00:00Z",
					witSource: wit,
				},
				{
					importModule: async () => Promise.reject(new Error("not installed")),
				},
			),
		).rejects.toBeInstanceOf(ComponentizeToolchainError);
	});
});
