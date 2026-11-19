import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "../json.js";
import { stableStringify } from "./text.js";
import { type CodegenLayout, defaultCodegenLayout } from "./types.js";

type FixtureValue =
	| JsonValue
	| readonly FixtureValue[]
	| { readonly [key: string]: FixtureValue }
	| ReadonlyMap<string, FixtureValue>
	| ReadonlySet<FixtureValue>;

export interface CodegenFixtureOptions {
	readonly reverse?: boolean;
	readonly layout?: CodegenLayout;
}

export async function writeFixtureProject(
	projectRoot: string,
	options: CodegenFixtureOptions = {},
): Promise<void> {
	const layout = options.layout ?? defaultCodegenLayout();
	const sources = fixtureSources(options);
	await writeText(join(projectRoot, layout.sources.wit), sources.wit);
	await writeJson(join(projectRoot, layout.sources.zod), sources.zod);
	await writeJson(join(projectRoot, layout.sources.allow), sources.allow);
	await writeJson(join(projectRoot, layout.sources.bindle), sources.bindle);
	await writeText(
		join(projectRoot, layout.sources.scanDir, "rank.ts"),
		`export async function rankFeed(input: { items: string[] }): Promise<{ ranked: string[] }> {\n` +
			`  "use training";\n` +
			`  // Rank feed items; stable sort as the initial implementation.\n` +
			`  return { ranked: [...input.items].sort() };\n` +
			`}\n`,
	);
}

export interface FixtureSources {
	readonly wit: string;
	readonly zod: FixtureValue;
	readonly allow: FixtureValue;
	readonly bindle: FixtureValue;
}

export function fixtureSources(
	options: CodegenFixtureOptions = {},
): FixtureSources {
	const reverse = options.reverse === true;
	const resourceEntries: readonly (readonly [string, FixtureValue])[] = [
		[
			"ticket",
			{
				fields: mapFromEntries(
					[
						["title", { type: "string" }],
						[
							"priority",
							{
								type: "enum",
								values: setFrom(["high", "normal", "low"], reverse),
							},
						],
						["id", { type: "string" }],
					],
					reverse,
				),
			},
		],
		[
			"incident",
			{
				fields: mapFromEntries(
					[
						["id", { type: "string" }],
						[
							"severity",
							{
								type: "enum",
								values: setFrom(["sev1", "sev2", "sev3"], reverse),
							},
						],
						["open", { type: "boolean" }],
					],
					reverse,
				),
			},
		],
	];
	const bindles = [
		{
			name: "support",
			provider: "camp",
			resources: setFrom(["ticket", "incident"], reverse),
			steps: setFrom(["ticket.validate", "incident.classify"], reverse),
			workflows: setFrom(["ticket.triage", "incident.restore"], reverse),
			with: mapFromEntries(
				[
					["region", setFrom(["us", "eu"], reverse)],
					["tier", setFrom(["free", "pro"], reverse)],
				],
				reverse,
			),
		},
	];

	return {
		wit: `package hobo:sdk@0.1.0;\n\nworld app {\n  export support;\n}\n\ninterface support {\n}\n`,
		zod: {
			resources: mapFromEntries(resourceEntries, reverse),
		},
		allow: {
			scopes: mapFromEntries(
				[
					[
						"ticket:read",
						{ grants: setFrom(["ticket.query", "ticket.subscribe"], reverse) },
					],
					[
						"incident:read",
						{
							grants: setFrom(
								["incident.query", "incident.subscribe"],
								reverse,
							),
						},
					],
				],
				reverse,
			),
		},
		bindle: {
			bindles: reverse ? [...bindles].reverse() : bindles,
		},
	};
}

async function writeJson(path: string, value: FixtureValue): Promise<void> {
	await writeText(path, stableStringify(value));
}

async function writeText(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value);
}

function mapFromEntries(
	entries: readonly (readonly [string, FixtureValue])[],
	reverse = false,
): Map<string, FixtureValue> {
	return new Map(reverse ? [...entries].reverse() : entries);
}

function setFrom(entries: readonly string[], reverse = false): Set<string> {
	return new Set(reverse ? [...entries].reverse() : entries);
}
