import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	parseWaspAppRoot,
	parseWaspEnvExample,
	parseWaspEnvKey,
	type WaspAppRoot,
	type WaspBindleDependencySuggestion,
	type WaspBindleKind,
	type WaspEnvExampleFile,
	type WaspEnvKey,
} from "./parse.js";

export const OPENSAAS_GENERAL_ENV = Object.freeze([
	"DATABASE_URL",
	"JWT_SECRET",
	"WASP_WEB_CLIENT_URL",
	"WASP_SERVER_URL",
] as const);

export const ENV_TO_BINDLE_KIND = Object.freeze({
	DATABASE_URL: "container",
	STRIPE_: "external",
	LEMONSQUEEZY_: "external",
	POLAR_: "external",
	PAYMENTS_: "external",
	SENDGRID_: "external",
	SMTP_: "external",
	AWS_S3_: "bucket",
	OPENAI_: "external",
	GOOGLE_CLIENT_: "external",
	GITHUB_CLIENT_: "external",
	PLAUSIBLE_: "external",
	GOOGLE_ANALYTICS_: "external",
	REACT_APP_: "env",
} as const);

export type WaspSourceReader = {
	readFile(absolutePath: string): Promise<string | undefined>;
};

export const nodeWaspSourceReader: WaspSourceReader = {
	async readFile(absolutePath) {
		try {
			return await readFile(absolutePath, "utf8");
		} catch {
			return undefined;
		}
	},
};

export type DiscoverWaspEnvOptions = {
	readonly reader?: WaspSourceReader;
};

export type DiscoveredWaspEnv = {
	readonly root: string;
	readonly absRoot: string;
	readonly appRoot: WaspAppRoot;
	readonly generalEnv: readonly string[];
	readonly server: WaspEnvExampleFile;
	readonly client: WaspEnvExampleFile;
	readonly serverExampleKeys: readonly WaspEnvKey[];
	readonly clientExampleKeys: readonly WaspEnvKey[];
	readonly suggestedDeps: readonly WaspBindleDependencySuggestion[];
};

function suggestDeps(
	keys: readonly WaspEnvKey[],
): readonly WaspBindleDependencySuggestion[] {
	const buckets = new Map<
		WaspBindleKind,
		{ via: string; keys: WaspEnvKey[] }
	>();
	for (const key of keys) {
		let kind: WaspBindleKind = "external";
		let via = "b.external() connector / camp env";
		if (key === "DATABASE_URL") {
			kind = "container";
			via = "b.container({ image }) OCI Postgres, or b.external() BYO";
		} else if (key.startsWith("AWS_S3_")) {
			kind = "bucket";
			via = "b.bucket() / external S3 connector";
		} else if (key.startsWith("REACT_APP_")) {
			kind = "env";
			via = "client env (Wasp REACT_APP_*)";
		} else {
			for (const [prefix, mapped] of Object.entries(ENV_TO_BINDLE_KIND)) {
				if (prefix.endsWith("_") && key.startsWith(prefix)) {
					kind = mapped;
					via =
						mapped === "external"
							? "b.external() connector / camp secrets"
							: `Bindle kind ${mapped}`;
					break;
				}
			}
		}
		const bucket = buckets.get(kind) ?? { via, keys: [] };
		if (!bucket.keys.includes(key)) bucket.keys.push(key);
		buckets.set(kind, bucket);
	}
	return Object.freeze(
		[...buckets.entries()].map(([kind, value]) =>
			Object.freeze({
				kind,
				via: value.via,
				keys: Object.freeze(value.keys),
			}),
		),
	);
}

export function resolveWaspRoot(repoRoot: string, root: string): string {
	return parseWaspAppRoot(repoRoot, root).absolute;
}

export async function discoverWaspEnv(
	repoRoot: string,
	root: string,
	options: DiscoverWaspEnvOptions = {},
): Promise<DiscoveredWaspEnv> {
	const appRoot = parseWaspAppRoot(repoRoot, root);
	const reader = options.reader ?? nodeWaspSourceReader;

	const server = parseWaspEnvExample(
		(await reader.readFile(
			path.join(appRoot.absolute, ".env.server.example"),
		)) ?? "",
		".env.server.example",
	);
	const client = parseWaspEnvExample(
		(await reader.readFile(
			path.join(appRoot.absolute, ".env.client.example"),
		)) ?? "",
		".env.client.example",
	);

	const allKeys = [
		...OPENSAAS_GENERAL_ENV.map((key) => parseWaspEnvKey(key)),
		...server.keys,
		...client.keys,
	];

	return Object.freeze({
		root: appRoot.relative,
		absRoot: appRoot.absolute,
		appRoot,
		generalEnv: OPENSAAS_GENERAL_ENV,
		server,
		client,
		serverExampleKeys: server.keys,
		clientExampleKeys: client.keys,
		suggestedDeps: suggestDeps(allKeys),
	});
}
