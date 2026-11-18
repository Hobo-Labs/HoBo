import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss, { type Rule } from "postcss";
import { controlYardPropViolations } from "./lib/control-yard-props.js";

type Source = { path: string; css: string };

function palette(
	source: Source,
	selector: string,
	anchor: string,
	media?: string,
): Map<string, string> {
	const matches: Rule[] = [];
	postcss.parse(source.css, { from: source.path }).walkRules((rule) => {
		const parent = rule.parent;
		const matchingParent = media
			? parent?.type === "atrule" &&
				parent.name === "media" &&
				parent.params === media
			: parent?.type === "root";
		if (
			matchingParent &&
			rule.selectors.includes(selector) &&
			rule.nodes.some((node) => node.type === "decl" && node.prop === anchor)
		)
			matches.push(rule);
	});
	const match = matches[0];
	if (matches.length !== 1 || !match)
		throw new Error(
			`${source.path}: expected one ${selector} palette${media ? ` in ${media}` : ""}, found ${matches.length}`,
		);
	const values = new Map<string, string>();
	match.walkDecls(/^--/u, (declaration) => {
		if (values.has(declaration.prop))
			throw new Error(
				`${source.path}:${declaration.source?.start?.line}: duplicate ${declaration.prop}`,
			);
		values.set(declaration.prop, declaration.value);
	});
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

function checkPairs(
	source: Source,
	selector: string,
	pairs: readonly (readonly [string, string])[],
	media?: string,
): string[] {
	const anchor = pairs[0]?.[1];
	if (!anchor) throw new Error(`${source.path}: no contrast pairs configured`);
	const values = palette(source, selector, anchor, media);
	return pairs.flatMap(([foreground, background]) => {
		const foregroundValue = values.get(foreground);
		const backgroundValue = values.get(background);
		if (!foregroundValue || !backgroundValue)
			return [
				`${source.path}: ${selector} must define ${foreground} and ${background}`,
			];
		try {
			const ratio = contrastRatio(foregroundValue, backgroundValue);
			return ratio < 4.5
				? [
						`${source.path}: ${selector} ${foreground} on ${background} has contrast ${ratio.toFixed(2)}; minimum is 4.5`,
					]
				: [];
		} catch (error) {
			return [
				`${source.path}: ${selector} ${error instanceof Error ? error.message : String(error)}`,
			];
		}
	});
}

export function checkVisualTokens(site: Source, connect: Source): string[] {
	const sitePairs = [
		["--text", "--bg"],
		["--text", "--bg-raised"],
		["--text", "--bg-inset"],
		["--text-mute", "--bg"],
		["--text-faint", "--bg"],
	] as const;
	const connectPairs = [
		["--ink", "--paper"],
		["--ink", "--cream"],
		["--mute", "--paper"],
	] as const;
	const selectors = [
		':root[data-theme="light"]',
		':root[data-theme="dark"]',
		...["cutout", "broadsheet", "titlecard", "ledger"].flatMap((design) => [
			`:root[data-design="${design}"]`,
			`:root[data-design="${design}"][data-theme="dark"]`,
		]),
	];
	try {
		return [
			...selectors.flatMap((selector) => checkPairs(site, selector, sitePairs)),
			...checkPairs(connect, ":root", connectPairs),
			...checkPairs(
				connect,
				":root",
				connectPairs,
				"(prefers-color-scheme: dark)",
			),
		];
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}

function main(): number {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const source = (path: string): Source => ({
		path,
		css: readFileSync(join(root, path), "utf8"),
	});
	const errors = [
		...checkVisualTokens(
			source("site/src/styles/global.css"),
			source("packages/connect-ui/src/client/styles.css"),
		),
		...controlYardPropViolations(
			readFileSync(
				join(root, "packages/control-yard/public/yard-game.js"),
				"utf8",
			),
		),
	];
	for (const error of errors) console.error(error);
	if (errors.length) return 1;
	console.log("visual policy checks passed");
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main();
