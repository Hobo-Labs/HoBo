import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss, { type Rule } from "postcss";
import { z } from "zod";
import contract from "./visual-token-contract.json" with { type: "json" };

type Source = { path: string; css: string };
type ContrastPair = { foreground: string; background: string };
type Theme = { selector: string; media?: string };
type CssContract = {
	palette: string;
	contrast: readonly ContrastPair[];
	themes: readonly Theme[];
};
type PackageInfo = { webUi: boolean; webFramework: boolean };

export type VisualTokenProject = { rel: string; reason: string };

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_UI_ROOTS = ["site"] as const;
export const WEB_FRAMEWORK_DEPS = new Set([
	"astro",
	"next",
	"nuxt",
	"@sveltejs/kit",
	"@remix-run/react",
	"gatsby",
	"vitepress",
	"@docusaurus/core",
]);
const SKIP_NAMES = new Set([
	"node_modules",
	"dist",
	"build",
	".git",
	"coverage",
	".turbo",
]);
const dependencySchema = z.record(z.string(), z.string());
const packageManifestSchema = z.object({
	hobo: z.object({ webUi: z.boolean().optional() }).optional(),
	dependencies: dependencySchema.optional(),
	devDependencies: dependencySchema.optional(),
	peerDependencies: dependencySchema.optional(),
});

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

function readPackageInfo(dir: string): PackageInfo | null {
	const manifestPath = join(dir, "package.json");
	let text: string;
	try {
		text = readFileSync(manifestPath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	const manifest = packageManifestSchema.parse(JSON.parse(text));
	const dependencies = new Set<string>([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);
	return {
		webUi: manifest.hobo?.webUi === true,
		webFramework: [...WEB_FRAMEWORK_DEPS].some((name) =>
			dependencies.has(name),
		),
	};
}

export function discoverPackageDirs(repoRoot = repositoryRoot): string[] {
	const projects: string[] = [];
	const consider = (dir: string) => {
		if (isDirectory(dir) && readPackageInfo(dir)) projects.push(dir);
	};
	const walk = (dir: string, depth: number) => {
		if (!isDirectory(dir) || depth > 6) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (
				!entry.isDirectory() ||
				SKIP_NAMES.has(entry.name) ||
				entry.name.startsWith(".")
			)
				continue;
			const child = join(dir, entry.name);
			consider(child);
			walk(child, depth + 1);
		}
	};
	consider(join(repoRoot, "site"));
	for (const seed of ["packages", "examples", "apps"])
		walk(join(repoRoot, seed), 0);
	return [...new Set(projects)];
}

const CONTRACT_PROJECTS = new Set(
	Object.values(contract).map((entry) => entry.project),
);

export function listWebUiProjects(
	repoRoot = repositoryRoot,
): VisualTokenProject[] {
	const candidates = new Set<string>([
		...[...WEB_UI_ROOTS, ...CONTRACT_PROJECTS].map((path) =>
			join(repoRoot, path),
		),
		...discoverPackageDirs(repoRoot),
	]);
	const projects: VisualTokenProject[] = [];
	for (const dir of candidates) {
		const rel = relative(repoRoot, dir).replaceAll("\\", "/") || ".";
		const contractListed = CONTRACT_PROJECTS.has(rel);
		if (!contractListed && !isDirectory(dir)) continue;
		const knownRoot = WEB_UI_ROOTS.some((path) => path === rel);
		const pkg = isDirectory(dir) ? readPackageInfo(dir) : null;
		if (!contractListed && !knownRoot && !pkg?.webUi && !pkg?.webFramework)
			continue;
		projects.push({
			rel,
			reason: contractListed
				? "visual token contract"
				: knownRoot
					? "web-ui root"
					: pkg?.webUi
						? "hobo.webUi"
						: "web framework dependency",
		});
	}
	return projects.sort((first, second) => first.rel.localeCompare(second.rel));
}

function palette(
	source: Source,
	selector: string,
	anchor: string,
	media?: string,
): Map<string, string> {
	const rules: Rule[] = [];
	postcss.parse(source.css, { from: source.path }).walkRules((rule) => {
		const parent = rule.parent;
		const matchingParent = media
			? parent?.type === "atrule" &&
				parent.name === "media" &&
				parent.params === media
			: parent?.type === "root";
		if (matchingParent && rule.selectors.includes(selector)) rules.push(rule);
	});
	if (rules.length === 0)
		throw new Error(
			`${source.path}: expected a ${selector} palette${media ? ` in ${media}` : ""}, found none`,
		);
	const values = new Map<string, string>();
	let hasAnchor = false;
	for (const rule of rules) {
		for (const node of rule.nodes ?? []) {
			if (node.type !== "decl" || !node.prop.startsWith("--")) continue;
			values.set(node.prop, node.value);
			if (node.prop === anchor) hasAnchor = true;
		}
	}
	if (!hasAnchor)
		throw new Error(
			`${source.path}: ${selector}${media ? ` in ${media}` : ""} must define ${anchor}`,
		);
	return values;
}

function luminance(value: string): number {
	if (!/^#[0-9a-f]{6}$/iu.test(value))
		throw new Error(`expected a six-digit hex color, got ${value}`);
	const channelLuminance = (index: number) => {
		const channel = Number.parseInt(value.slice(index, index + 2), 16) / 255;
		return channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	};
	return (
		0.2126 * channelLuminance(1) +
		0.7152 * channelLuminance(3) +
		0.0722 * channelLuminance(5)
	);
}

export function contrastRatio(foreground: string, background: string): number {
	const first = luminance(foreground);
	const second = luminance(background);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function contrastError(
	path: string,
	selector: string,
	foreground: string,
	background: string,
	foregroundValue: string | undefined,
	backgroundValue: string | undefined,
): string[] {
	if (!foregroundValue || !backgroundValue)
		return [`${path}: ${selector} must define ${foreground} and ${background}`];
	try {
		const ratio = contrastRatio(foregroundValue, backgroundValue);
		return ratio < 4.5
			? [
					`${path}: ${selector} ${foreground} on ${background} has contrast ${ratio.toFixed(2)}; minimum is 4.5`,
				]
			: [];
	} catch (error) {
		return [
			`${path}: ${selector} ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

function checkPairs(
	source: Source,
	selector: string,
	pairs: readonly ContrastPair[],
	media?: string,
): string[] {
	const anchor = pairs[0]?.background;
	if (!anchor) throw new Error(`${source.path}: no contrast pairs configured`);
	const values = palette(source, selector, anchor, media);
	return pairs.flatMap(({ foreground, background }) =>
		contrastError(
			source.path,
			selector,
			foreground,
			background,
			values.get(foreground),
			values.get(background),
		),
	);
}

function checkCssThemes(source: Source, config: CssContract): string[] {
	try {
		return config.themes.flatMap((theme) =>
			checkPairs(source, theme.selector, config.contrast, theme.media),
		);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}

export function checkVisualTokens(site: Source, connect: Source): string[] {
	return [
		...checkCssThemes(site, contract.site),
		...checkCssThemes(connect, contract["connect-ui"]),
	];
}

function readSource(repoRoot: string, path: string): Source {
	let css: string;
	try {
		css = readFileSync(join(repoRoot, path), "utf8");
	} catch (error) {
		throw new Error(
			`${path}: unable to read palette: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!css.trim()) throw new Error(`${path}: palette is empty`);
	return { path, css };
}

function embeddedStyle(source: Source): Source {
	const startMarker = "const STYLE = `";
	const endMarker = "`;\n\nconst SCRIPT";
	const start = source.css.indexOf(startMarker);
	const bodyStart = start + startMarker.length;
	const end = source.css.indexOf(endMarker, bodyStart);
	if (
		start < 0 ||
		start !== source.css.lastIndexOf(startMarker) ||
		end < bodyStart
	)
		throw new Error(`${source.path}: expected one embedded STYLE palette`);
	return { path: source.path, css: source.css.slice(bodyStart, end) };
}

function checkHexSet(
	source: Source,
	expectedTokens: Record<string, string>,
): string[] {
	const actual = [
		...new Set(
			(source.css.match(/#[0-9a-fA-F]{6}\b/gu) ?? []).map((hex) =>
				hex.toLowerCase(),
			),
		),
	].sort();
	const expected = [
		...new Set(Object.values(expectedTokens).map((hex) => hex.toLowerCase())),
	].sort();
	return JSON.stringify(actual) === JSON.stringify(expected)
		? []
		: [
				`${source.path}: palette differs from scripts/visual-token-contract.json; expected ${expected.join(", ")}, found ${actual.join(", ") || "none"}`,
			];
}

function statusTokens(source: Source): Map<string, string> {
	const startMarker = "export const STATUS_PAGE_TOKENS = {";
	const endMarker = "} as const;";
	const start = source.css.indexOf(startMarker);
	const bodyStart = start + startMarker.length;
	const end = source.css.indexOf(endMarker, bodyStart);
	if (
		start < 0 ||
		start !== source.css.lastIndexOf(startMarker) ||
		end < bodyStart
	)
		throw new Error(`${source.path}: expected one STATUS_PAGE_TOKENS palette`);
	const values = new Map<string, string>();
	for (const line of source.css.slice(bodyStart, end).split("\n")) {
		if (!line.trim()) continue;
		const match = /^([A-Za-z][A-Za-z0-9]*): "(#[0-9a-fA-F]{6})",$/u.exec(
			line.trim(),
		);
		const name = match?.[1];
		const value = match?.[2];
		if (!name || !value)
			throw new Error(
				`${source.path}: invalid token declaration: ${line.trim()}`,
			);
		if (values.has(name))
			throw new Error(`${source.path}: duplicate token ${name}`);
		values.set(name, value.toLowerCase());
	}
	return values;
}

function checkStatusPage(source: Source): string[] {
	try {
		const values = statusTokens(source);
		const expected = Object.entries(contract["status-page"].tokens).sort(
			([first], [second]) => first.localeCompare(second),
		);
		const actual = [...values.entries()].sort(([first], [second]) =>
			first.localeCompare(second),
		);
		const contractErrors =
			JSON.stringify(actual) === JSON.stringify(expected)
				? []
				: [
						`${source.path}: tokens differ from scripts/visual-token-contract.json`,
					];
		return [
			...contractErrors,
			...contract["status-page"].contrast.flatMap(
				({ foreground, background }) =>
					contrastError(
						source.path,
						"STATUS_PAGE_TOKENS",
						foreground,
						background,
						values.get(foreground),
						values.get(background),
					),
			),
		];
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}

function checkProject(repoRoot: string, project: VisualTokenProject): string[] {
	try {
		if (CONTRACT_PROJECTS.has(project.rel)) {
			const dir = join(repoRoot, project.rel);
			if (!isDirectory(dir))
				return [`${project.rel}: contract-listed project directory is missing`];
			if (!readPackageInfo(dir))
				return [
					`${project.rel}/package.json: contract-listed project manifest is missing`,
				];
		}
		switch (project.rel) {
			case contract.site.project:
				return checkCssThemes(
					readSource(repoRoot, contract.site.palette),
					contract.site,
				);
			case contract["connect-ui"].project:
				return checkCssThemes(
					readSource(repoRoot, contract["connect-ui"].palette),
					contract["connect-ui"],
				);
			case contract.mcp.project: {
				const source = embeddedStyle(
					readSource(repoRoot, contract.mcp.palette),
				);
				return [
					...checkHexSet(source, contract.mcp.tokens),
					...checkCssThemes(source, contract.mcp),
				];
			}
			case contract["status-page"].project:
				return checkStatusPage(
					readSource(repoRoot, contract["status-page"].palette),
				);
			default:
				return [
					`${project.rel}: web UI project has no entry in scripts/visual-token-contract.json`,
				];
		}
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}

export function checkRepositoryVisualTokens(
	repoRoot = repositoryRoot,
): string[] {
	let projects: VisualTokenProject[];
	try {
		projects = listWebUiProjects(repoRoot);
	} catch (error) {
		return [
			`web UI discovery failed: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
	return projects.flatMap((project) => checkProject(repoRoot, project));
}

function main(): number {
	const errors = checkRepositoryVisualTokens();
	for (const error of errors) console.error(error);
	if (errors.length) return 1;
	console.log(
		`visual token contrast checks passed for ${listWebUiProjects().length} web UI projects`,
	);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main();
