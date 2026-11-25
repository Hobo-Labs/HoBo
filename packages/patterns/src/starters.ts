import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { defaultCatalogRoot, loadPatternCatalog } from "./catalog.js";
import { PatternParseError } from "./parse.js";
import { fillTemplate } from "./render.js";

export const CLI_STARTER_ALIASES = [
	"todo",
	"api",
	"agent",
	"fullstack",
] as const;
export type CliStarterAlias = (typeof CLI_STARTER_ALIASES)[number];

export function catalogStarterId(template: CliStarterAlias): string {
	return `starter.cli.${template}`;
}

export function isCliStarterAlias(value: string): value is CliStarterAlias {
	return (CLI_STARTER_ALIASES as readonly string[]).includes(value);
}

export function catalogStarterProjectRoot(template: CliStarterAlias): string {
	return join(defaultCatalogRoot(), "starter", "cli", template, "project");
}

export function assertCatalogStarter(template: CliStarterAlias): void {
	const catalog = loadPatternCatalog();
	const id = catalogStarterId(template);
	if (!catalog.patterns.some((item) => item.id === id)) {
		throw new PatternParseError(`catalog missing ${id}`);
	}
}

function details(template: CliStarterAlias): Record<string, string> {
	switch (template) {
		case "todo":
			return {
				runtimeName: "Todo",
				resourceName: "todoStore",
				route: "/todos",
				seedKey: "first-task",
				message: "Track a first HoBo task",
			};
		case "api":
			return {
				runtimeName: "Api",
				resourceName: "apiStore",
				route: "/api/hello",
				seedKey: "hello",
				message: "Hello from HoBo",
			};
		case "agent":
			return {
				runtimeName: "Agent",
				resourceName: "agentStore",
				route: "/agent/run",
				seedKey: "first-run",
				message: "Agent handler ready",
			};
		case "fullstack":
			return {
				runtimeName: "Fullstack",
				resourceName: "fullstackStore",
				route: "/app",
				seedKey: "home",
				message: "Fullstack shell ready",
			};
	}
}

function walkFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...walkFiles(full, base));
		} else {
			out.push(relative(base, full).replaceAll("\\", "/"));
		}
	}
	return out;
}

export function renderCliStarterFiles(input: {
	readonly name: string;
	readonly template: CliStarterAlias;
}): Map<string, string> {
	assertCatalogStarter(input.template);
	const root = join(
		defaultCatalogRoot(),
		"starter",
		"cli",
		input.template,
		"project",
	);
	if (!existsSync(root)) {
		throw new PatternParseError(`catalog starter tree missing ${root}`);
	}
	const params = {
		name: input.name,
		template: input.template,
		...details(input.template),
	};
	const files = new Map<string, string>();
	for (const rel of walkFiles(root)) {
		const dest = rel
			.replace(/\.tpl$/u, "")
			.replace(/^seed\//u, "src/_generated/");
		files.set(
			dest,
			fillTemplate(readFileSync(join(root, rel), "utf8"), params),
		);
	}
	return files;
}
