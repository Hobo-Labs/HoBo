import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
