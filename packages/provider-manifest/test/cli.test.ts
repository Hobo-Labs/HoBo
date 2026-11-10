import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { EXAMPLE_PATH } from "./support/example.js";

function invoke(...argv: string[]) {
	const lines: string[] = [];
	const code = run(argv, (line) => lines.push(line));
	return { code, lines };
}

describe("hobo-provider-manifest", () => {
	it("checks a valid manifest and names its unrated plans", () => {
		const { code, lines } = invoke("check", EXAMPLE_PATH);
		expect(code).toBe(0);
		expect(lines.at(-1)).toContain(": ok");
		expect(lines.join("\n")).toContain("unrated plan llm-large/spot");
	});

	it("exits 1 and prints each issue with its path", () => {
		const dir = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		const file = join(dir, "bad.json");
		writeFileSync(
			file,
			JSON.stringify({
				schema: "hobo.provider-manifest/v1",
				provider: { id: "Bad Id", displayName: "Bad" },
			}),
		);
		const { code, lines } = invoke("check", file);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("provider.id: must be a lowercase slug");
	});

	it("writes the derived documents", () => {
		const out = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		expect(invoke("lower", EXAMPLE_PATH, out).code).toBe(0);
		expect(readdirSync(out).sort()).toEqual([
			"auth.json",
			"capabilities.json",
			"cost.json",
			"index.json",
			"pricing-catalog.json",
		]);
		const catalog = JSON.parse(
			readFileSync(join(out, "pricing-catalog.json"), "utf8"),
		);
		expect(catalog.schema).toBe("hobo.pricing.catalog/v1");
	});

	it("generates a client and a code-mode MCP server from a manifest's spec", () => {
		const out = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		const { code, lines } = invoke("generate", EXAMPLE_PATH, out);
		expect(code).toBe(0);
		expect(readdirSync(out).sort()).toEqual([
			"mcp.json",
			"pets.client.ts",
			"pets.mcp-server.mjs",
		]);
		// Declared, but not a format generation covers: said, not skipped silently.
		expect(lines.join("\n")).toContain("skipped events");
	});

	it("generates from a bare OpenAPI file, naming outputs after its title", () => {
		const out = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		const spec = join(dirname(EXAMPLE_PATH), "petstore.openapi.yaml");
		expect(invoke("generate", spec, out).code).toBe(0);
		expect(readdirSync(out).sort()).toEqual([
			"acme-pets.client.ts",
			"acme-pets.mcp-server.mjs",
			"mcp.json",
		]);
		expect(JSON.parse(readFileSync(join(out, "mcp.json"), "utf8"))).toEqual({
			mcpServers: {
				"acme-pets": { command: "node", args: ["./acme-pets.mcp-server.mjs"] },
			},
		});
	});

	it("uses the provider's own MCP server instead of generating one", () => {
		const dir = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		writeFileSync(
			join(dir, "openapi.yaml"),
			readFileSync(join(dirname(EXAMPLE_PATH), "petstore.openapi.yaml")),
		);
		const manifest = join(dir, "provider.yaml");
		writeFileSync(
			manifest,
			[
				"schema: hobo.provider-manifest/v1",
				"provider: { id: has-mcp, displayName: Has MCP }",
				"api:",
				"  specs:",
				"    - { id: rest, format: openapi, path: openapi.yaml }",
				"    - { id: published, format: openapi, url: https://has-mcp.example.com/openapi.json }",
				"  mcpServers:",
				"    - { id: remote, url: https://mcp.has-mcp.example.com/mcp }",
			].join("\n"),
		);
		const out = join(dir, "out");
		const { code, lines } = invoke("generate", manifest, out);
		expect(code).toBe(0);
		expect(readdirSync(out).sort()).toEqual(["mcp.json", "rest.client.ts"]);
		expect(JSON.parse(readFileSync(join(out, "mcp.json"), "utf8"))).toEqual({
			mcpServers: {
				remote: { type: "http", url: "https://mcp.has-mcp.example.com/mcp" },
			},
		});
		// A published spec is not fetched; the author is told what to do.
		expect(lines.join("\n")).toContain("skipped published: save https://");
	});

	it("exits 1 when a referenced spec is invalid or missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		const manifest = join(dir, "provider.yaml");
		const body = (path: string) =>
			`schema: hobo.provider-manifest/v1\nprovider: { id: p, displayName: P }\napi:\n  specs:\n    - { id: rest, format: openapi, path: ${path} }\n`;
		writeFileSync(manifest, body("missing.yaml"));
		expect(invoke("generate", manifest, join(dir, "out")).code).toBe(1);
		writeFileSync(join(dir, "v2.yaml"), 'swagger: "2.0"\npaths: {}\n');
		writeFileSync(manifest, body("v2.yaml"));
		const { code, lines } = invoke("generate", manifest, join(dir, "out"));
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("only OpenAPI 3.0 and 3.1");
		expect(
			invoke("generate", join(dir, "v2.yaml"), join(dir, "out")).code,
		).toBe(1);
	});

	it("says so when a manifest has nothing to generate", () => {
		const dir = mkdtempSync(join(tmpdir(), "provider-manifest-"));
		const manifest = join(dir, "provider.yaml");
		writeFileSync(
			manifest,
			"schema: hobo.provider-manifest/v1\nprovider: { id: p, displayName: P }\nauth:\n  issuer: https://a.example.com\n  flows:\n    - id: f\n      oidcFederation: { audience: hobo }\n",
		);
		const { code, lines } = invoke("generate", manifest, join(dir, "out"));
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("nothing to generate");
	});

	it("exits 2 on bad usage or an unreadable file", () => {
		expect(invoke().code).toBe(2);
		expect(invoke("lower", EXAMPLE_PATH).code).toBe(2);
		const missing = join(
			mkdtempSync(join(tmpdir(), "provider-manifest-")),
			"missing.yaml",
		);
		expect(invoke("check", missing).code).toBe(2);
	});
});
