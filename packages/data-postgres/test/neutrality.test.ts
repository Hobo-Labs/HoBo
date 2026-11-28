import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POSTGRES_MIGRATION_TOOLS } from "../src/capabilities.js";
import * as api from "../src/index.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const TOOL_LITERALS: readonly string[] = POSTGRES_MIGRATION_TOOLS;

function stripToolNames(line: string): string {
	let out = line.toLowerCase();
	for (const tool of TOOL_LITERALS) out = out.split(tool).join("");
	return out;
}

const PROVIDER_TOKENS = [
	"neon",
	"prisma",
	"supabase",
	"vercel",
	"cloudflare",
	"aws",
	"azure",
	"gcp",
	"railway",
	"render",
	"fly.io",
	"planetscale",
	"crunchy",
	"timescale",
	"heroku",
	"digitalocean",
	"cockroach",
	"xata",
	"nile",
	"tembo",
];

function sourceFiles(directory: string): readonly string[] {
	const out: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

describe("provider neutrality", () => {
	const files = sourceFiles(SRC);

	it("has sources to check", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("names no provider or product anywhere in src/", () => {
		const offences: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				const lowered = stripToolNames(line);
				for (const token of PROVIDER_TOKENS) {
					if (lowered.includes(token)) {
						offences.push(`${file}:${index + 1} mentions ${token}`);
					}
				}
			});
		}
		expect(offences).toEqual([]);
	});

	it("imports nothing from a provider package", () => {
		const offences: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/from\s+"([^"]+)"/gu)) {
				const specifier = match[1] ?? "";
				if (
					specifier.startsWith("@hobo/provider-") ||
					specifier.includes("providers/")
				) {
					offences.push(`${file} imports ${specifier}`);
				}
			}
		}
		expect(offences).toEqual([]);
	});

	it("imports no database driver: the engine binding takes an injected executor", () => {
		const offences: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/from\s+"([^"]+)"/gu)) {
				const specifier = match[1] ?? "";
				if (specifier === "pg" || specifier.startsWith("pg-")) {
					offences.push(`${file} imports ${specifier}`);
				}
			}
		}
		expect(offences).toEqual([]);
	});

	it("depends only on the capability vocabulary, the engine-neutral data contract and the engine-neutral fleet register at runtime", () => {
		const manifestPath = fileURLToPath(
			new URL("../package.json", import.meta.url),
		);
		type PackageManifest = { readonly dependencies?: Record<string, string> };
		// SAFETY: package.json is the local repository manifest and has the declared shape.
		const manifest = JSON.parse(
			readFileSync(manifestPath, "utf8"),
		) as PackageManifest;
		const names = Object.keys(manifest.dependencies ?? {});
		expect(names).toEqual([
			"@hobo/backend-routing",
			"@hobo/capability-profiles",
			"@hobo/data-core",
			"@hobo/fleet",
		]);
	});

	it("exports no symbol whose name carries a provider", () => {
		const offences = Object.keys(api).filter((name) => {
			const lowered = name.toLowerCase();
			return PROVIDER_TOKENS.some((token) => lowered.includes(token));
		});
		expect(offences).toEqual([]);
	});
});
