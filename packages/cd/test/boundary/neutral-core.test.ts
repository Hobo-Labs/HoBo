// I11 — Neutral core (plan 0024 §6). @hobo/cd imports no provider-*, iac-*,
// runtime-*, ci*, broker, cli, hobo or resolver-components, and names no
// Kubernetes / OCI-runtime / Git-host / Argo / Flux / vendor-APM type outside
// `adapters/` and `verification/sources/`. This scan runs over whatever
// modules exist, so it keeps holding as sibling work packages merge.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(packageRoot, "src");

// Excluded: vendor adapters, health-source adapters, and the generated code
// of the frozen contract (its SCREAMING_CASE enum labels name sources, not types).
const EXCLUDED = ["_generated", "adapters", join("verification", "sources")];

const FORBIDDEN_IMPORT =
	/^@hobo\/(?:provider-[\w-]+|iac(?:-[\w-]+)?|runtime-[\w-]+|ci(?:-[\w-]+)?|broker|cli|hobo|resolver-components)(?:\/.*)?$/u;

// Vendor words, matched against the Pascal-case segments of type-like names.
const VENDOR_WORDS = [
	"kube",
	"kubernetes",
	"kubectl",
	"kubeconfig",
	"k8s",
	"argo",
	"argocd",
	"flux",
	"fluxcd",
	"kustomization",
	"kustomize",
	"helm",
	"helmrelease",
	"karmada",
	"manifestwork",
	"github",
	"gitlab",
	"gitea",
	"forgejo",
	"bitbucket",
	"datadog",
	"newrelic",
	"dynatrace",
	"prometheus",
	"containerd",
	"docker",
	"dockerd",
	"runc",
	"crio",
] as const;

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const rel = relative(srcRoot, path);
		if (EXCLUDED.some((ex) => rel === ex || rel.startsWith(`${ex}${sep}`)))
			continue;
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (/\.(?:ts|mts|cts|tsx)$/u.test(name) && !name.endsWith(".d.ts"))
			out.push(path);
	}
	return out.sort();
}

/** Remove comments and string/template literals, keeping line structure. */
export function stripNonCode(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
		} else if (c === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
				if (text[i] === "\n") out += "\n";
				i += 1;
			}
			i += 2;
		} else if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			i += 1;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === "\\") i += 1;
				else if (text[i] === "\n") out += "\n";
				i += 1;
			}
			i += 1;
			out += '""';
		} else {
			out += c;
			i += 1;
		}
	}
	return out;
}

/** Module specifiers of import/export-from/dynamic import statements. */
export function importSpecifiers(text: string): string[] {
	const specs: string[] = [];
	const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/gu;
	for (const match of text.matchAll(pattern))
		if (match[1]) specs.push(match[1]);
	return specs;
}

/** Vendor-named identifiers in code (comments and strings excluded). */
export function vendorIdentifiers(text: string): string[] {
	const found: string[] = [];
	for (const match of stripNonCode(text).matchAll(/[A-Za-z_$][\w$]*/gu)) {
		const id = match[0];
		// I11 is about *types*: PascalCase names (types, interfaces, classes,
		// enums). SCREAMING_CASE labels and camelCase values are not types.
		if (!/^[A-Z]/u.test(id) || !/[a-z]/u.test(id)) continue;
		const words = id
			.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
			.split(/[\s_$]+/u)
			.map((w) => w.toLowerCase())
			.filter(Boolean);
		// Single segments and adjacent pairs (Git+Hub, New+Relic, Manifest+Work).
		const candidates = [
			...words,
			...words.slice(1).map((w, i) => `${words[i]}${w}`),
		];
		if (
			candidates.some((w) => (VENDOR_WORDS as readonly string[]).includes(w))
		) {
			found.push(id);
		}
	}
	return found;
}

describe("I11 neutral core scan", () => {
	const files = sourceFiles(srcRoot);

	it("finds the package sources (the scan is not vacuous)", () => {
		expect(files.some((f) => f.endsWith(`boundary${sep}projection.ts`))).toBe(
			true,
		);
		expect(files.some((f) => f.includes(`${sep}_generated${sep}`))).toBe(false);
	});

	it("@hobo/cd imports no provider, iac, runtime, ci, broker, cli, hobo or resolver-components module", () => {
		const offenders = files.flatMap((file) =>
			importSpecifiers(readFileSync(file, "utf8"))
				.filter((spec) => FORBIDDEN_IMPORT.test(spec))
				.map((spec) => `${relative(packageRoot, file)} → ${spec}`),
		);
		expect(offenders).toEqual([]);
		// SAFETY: assertion required at this I/O or test boundary.
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
		};
		expect(
			Object.keys(manifest.dependencies ?? {}).filter((d) =>
				FORBIDDEN_IMPORT.test(d),
			),
		).toEqual([]);
	});

	it("names no Kubernetes / OCI-runtime / Git-host / Argo / Flux / vendor-APM type outside adapters/", () => {
		const offenders = files.flatMap((file) =>
			vendorIdentifiers(readFileSync(file, "utf8")).map(
				(id) => `${relative(packageRoot, file)}: ${id}`,
			),
		);
		expect(offenders).toEqual([]);
	});

	it("the scanner itself catches what it must and ignores what it must", () => {
		expect(importSpecifiers('import { x } from "@hobo/provider-aws";')).toEqual(
			["@hobo/provider-aws"],
		);
		for (const spec of [
			"@hobo/provider-aws",
			"@hobo/ci",
			"@hobo/ci-gh-actions",
			"@hobo/broker",
			"@hobo/hobo",
			"@hobo/iac-pulumi",
			"@hobo/runtime-wasm",
			"@hobo/resolver-components",
			"@hobo/cli",
		]) {
			expect(FORBIDDEN_IMPORT.test(spec)).toBe(true);
		}
		for (const spec of [
			"@hobo/cloud",
			"@hobo/core",
			"@hobo/contracts",
			"@hobo/cd-gitops",
			"@hobo/identity",
		]) {
			expect(FORBIDDEN_IMPORT.test(spec)).toBe(false);
		}
		expect(
			vendorIdentifiers(
				"type V = ArgoCdApplication; let k: KubeClient; const x: GitHubRepo; let kubeClient;",
			),
		).toEqual(["ArgoCdApplication", "KubeClient", "GitHubRepo"]);
		expect(
			vendorIdentifiers(
				'// ArgoCd in a comment\nconst s = "GitHub in a string"; HealthSourceKind.PROMETHEUS;',
			),
		).toEqual([]);
		expect(
			vendorIdentifiers(
				"const fluxion = 1; const argonaut = 2; const helmet = 3;",
			),
		).toEqual([]);
		expect(
			vendorIdentifiers(
				"type A = NewRelicClient; type B = ManifestWorkSpec; interface GitlabToken {}",
			),
		).toEqual(["NewRelicClient", "ManifestWorkSpec", "GitlabToken"]);
	});
});
