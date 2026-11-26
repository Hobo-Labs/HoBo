/**
 * Discover Convex + WorkOS AuthKit env hints from a real app tree (swaghaus).
 * Sources: Vite env (VITE_*), convex/auth.config.ts, Convex deploy docs.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";

/** Env required for any Convex+Vite+WorkOS AuthKit ship (swaghaus). */
export const SWAGHAUS_GENERAL_ENV = Object.freeze([
	"CONVEX_DEPLOY_KEY",
	"VITE_CONVEX_URL",
	"VITE_WORKOS_CLIENT_ID",
	"VITE_WORKOS_REDIRECT_URI",
	"WORKOS_CLIENT_ID",
] as const);

export const ENV_TO_BINDLE_KIND = Object.freeze({
	CONVEX_DEPLOY_KEY: "env",
	VITE_CONVEX_URL: "env",
	VITE_WORKOS_: "external",
	WORKOS_: "external",
} as const);

export type DiscoveredConvexEnv = {
	readonly root: string;
	readonly absRoot: string;
	readonly hasConvexDir: boolean;
	readonly hasAuthConfig: boolean;
	readonly generalEnv: readonly string[];
	readonly suggestedDeps: readonly {
		readonly kind: string;
		readonly via: string;
		readonly keys: readonly string[];
	}[];
};

/** Resolve repo-relative convexApp(root) against a repo root. */
export function resolveConvexRoot(repoRoot: string, root: string): string {
	const abs = path.resolve(repoRoot, root);
	if (!abs.startsWith(path.resolve(repoRoot))) {
		throw new Error(`convexApp root escapes repo: ${root}`);
	}
	return abs;
}

function suggestDeps(
	keys: readonly string[],
): DiscoveredConvexEnv["suggestedDeps"] {
	const buckets = new Map<string, { via: string; keys: string[] }>();
	for (const key of keys) {
		let kind = "env";
		let via = "Camp env / broker secretRef";
		if (key === "CONVEX_DEPLOY_KEY") {
			kind = "env";
			via = "broker-minted deploy key (never Bindle config)";
		} else if (key.startsWith("VITE_WORKOS_") || key.startsWith("WORKOS_")) {
			kind = "external";
			via = "b.external() WorkOS AuthKit / Camp secretRef";
		} else if (key === "VITE_CONVEX_URL") {
			kind = "data";
			via = "b.data() realized by Matching → @hobo/provider-convex";
		}
		const bucket = buckets.get(kind) ?? { via, keys: [] };
		bucket.keys.push(key);
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

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Probe the Convex app root for `convex/` + auth.config and return ship env deps.
 */
export async function discoverConvexEnv(
	repoRoot: string,
	root: string,
): Promise<DiscoveredConvexEnv> {
	const absRoot = resolveConvexRoot(repoRoot, root);
	const hasConvexDir = await exists(path.join(absRoot, "convex"));
	const authConfigPath = path.join(absRoot, "convex", "auth.config.ts");
	const hasAuthConfig = await exists(authConfigPath);

	let generalEnv: string[] = [...SWAGHAUS_GENERAL_ENV];
	if (hasAuthConfig) {
		try {
			const text = await readFile(authConfigPath, "utf8");
			if (!text.includes("WORKOS")) {
				generalEnv = generalEnv.filter((key) => !key.includes("WORKOS"));
			}
		} catch {
			/* keep defaults */
		}
	}

	return Object.freeze({
		root,
		absRoot,
		hasConvexDir,
		hasAuthConfig,
		generalEnv: Object.freeze(generalEnv),
		suggestedDeps: suggestDeps(generalEnv),
	});
}
