/**
 * Discover Open SaaS / Wasp env + dep hints from a real app tree.
 * Source of truth: https://docs.opensaas.sh/guides/deploying/ (+ .env.*.example).
 */
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

/** General vars required for any Open SaaS deploy (docs). */
export const OPENSAAS_GENERAL_ENV = Object.freeze([
	"DATABASE_URL",
	"JWT_SECRET",
	"WASP_WEB_CLIENT_URL",
	"WASP_SERVER_URL",
] as const);

/** Map env key prefixes → Bindle resource kind for Matching / connectors. */
export const ENV_TO_BINDLE_KIND = Object.freeze({
	DATABASE_URL: "container", // or external BYO Postgres
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

/**
 * The filesystem seam.
 *
 * Discovery is the only effectful thing this package does, and it is one call:
 * read a declaration file, or report that it is absent. Injecting it is what
 * lets `contracts/wasp-app-source-tree.pact.json` be replayed without an app
 * tree on disk.
 */
export type WaspSourceReader = {
	/** Resolve to the file contents, or `undefined` when the file is absent. */
	readFile(absolutePath: string): Promise<string | undefined>;
};

export const nodeWaspSourceReader: WaspSourceReader = {
	async readFile(absolutePath) {
		try {
			return await readFile(absolutePath, "utf8");
		} catch {
			// Both example files are optional: an app may be checked out before
			// it has either, and that is a discovery with no keys, not an error.
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

/** Resolve repo-relative waspApp(root) against a repo root. */
export function resolveWaspRoot(repoRoot: string, root: string): string {
	return parseWaspAppRoot(repoRoot, root).absolute;
}

/**
 * Read `.env.server.example` / `.env.client.example` under the Wasp app and
 * combine with Open SaaS general deploy vars from the docs.
 *
 * What comes back holds declared **keys** only. The reader hands over file
 * text; `parseWaspEnvExample` drops every value unread.
 */
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
