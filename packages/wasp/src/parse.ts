import path from "node:path";

export type WaspEnvScope = "server" | "client" | "general";

export type WaspBindleKind = "container" | "bucket" | "external" | "env";

export type WaspEnvKey = string & { readonly __waspEnvKey: unique symbol };

// domain-view: richer than the wire form — both halves are branded/validated together, so "resolved against the repo root and still inside it" is a property of the value rather than a check somebody remembered. No buf codegen is wired for this package, so data-models/wasp_app.proto is the design-time view of this record.
export type WaspAppRoot = {
	readonly relative: string;
	readonly absolute: string;
};

// domain-view: richer than the wire form — `scope` is a closed union and `keys` are branded, and the type deliberately has no field in which a parsed value could be carried. No buf codegen is wired here, so data-models/wasp_app.proto is the design-time view of this record.
export type WaspEnvExampleFile = {
	readonly relativePath: string;
	readonly scope: Exclude<WaspEnvScope, "general">;
	readonly keys: readonly WaspEnvKey[];
};

// domain-view: richer than the wire form — `kind` is the closed Bindle-kind union rather than a free string. No buf codegen is wired here, so data-models/wasp_app.proto is the design-time view of this record.
export type WaspBindleDependencySuggestion = {
	readonly kind: WaspBindleKind;
	readonly via: string;
	readonly keys: readonly WaspEnvKey[];
};

// domain-view: richer than the wire form — the annotation config is narrowed to the two literal fields this package will emit, so an annotation carrying a source URL or a template id cannot be built. No buf codegen is wired here, so data-models/wasp_app.proto is the design-time view of this record.
export type WaspWebAppAnnotation = {
	readonly provider: "hobo";
	readonly option: "webapp";
	readonly framework: "wasp";
	readonly root: string;
};

export const WASP_REJECTED_CODE = "HOBO_WASP_INPUT_REJECTED" as const;

export class WaspInputRejectedError extends Error {
	readonly code = WASP_REJECTED_CODE;
	readonly field: string;

	constructor(field: string, reason: string) {
		super(`wasp rejected ${field}: ${reason}`);
		this.name = "WaspInputRejectedError";
		this.field = field;
	}
}

const ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CLIENT_ENV_PREFIX = "REACT_APP_";
const RELATIVE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/u;

const DOTS_ONLY_SEGMENT = /^\.+$/u;

export function isWaspEnvKey(value: unknown): value is WaspEnvKey {
	return typeof value === "string" && ENV_KEY.test(value);
}

export function parseWaspEnvKey(value: unknown, field = "envKey"): WaspEnvKey {
	if (!isWaspEnvKey(value)) {
		throw new WaspInputRejectedError(
			field,
			`expected an upper snake case env key, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

export function parseWaspRelativeRoot(value: unknown, field = "root"): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new WaspInputRejectedError(field, "expected a non-empty path");
	}
	const relative = value.trim().split(path.sep).join("/");
	if (
		!RELATIVE_PATH.test(relative) ||
		relative.split("/").some((segment) => DOTS_ONLY_SEGMENT.test(segment))
	) {
		throw new WaspInputRejectedError(
			field,
			`expected a repo-relative path without traversal, got ${JSON.stringify(value)}`,
		);
	}
	return relative;
}

export function parseWaspAppRoot(
	repoRoot: unknown,
	root: unknown,
): WaspAppRoot {
	if (typeof repoRoot !== "string" || repoRoot.length === 0) {
		throw new WaspInputRejectedError("repoRoot", "expected a non-empty path");
	}
	const relative = parseWaspRelativeRoot(root);
	const base = path.resolve(repoRoot);
	const absolute = path.resolve(base, relative);
	if (absolute !== base && !absolute.startsWith(base + path.sep)) {
		throw new WaspInputRejectedError(
			"root",
			`waspApp root escapes the repo: ${relative}`,
		);
	}
	return Object.freeze({ relative, absolute });
}

export function parseWaspEnvExample(
	text: unknown,
	relativePath: ".env.server.example" | ".env.client.example",
): WaspEnvExampleFile {
	if (typeof text !== "string") {
		throw new WaspInputRejectedError(
			relativePath,
			"expected the file contents as text",
		);
	}
	const scope = relativePath === ".env.client.example" ? "client" : "server";
	const keys: WaspEnvKey[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		const candidate = (
			separator === -1 ? trimmed : trimmed.slice(0, separator)
		).trim();
		if (!isWaspEnvKey(candidate)) continue;
		if (scope === "client" && !candidate.startsWith(CLIENT_ENV_PREFIX))
			continue;
		if (!keys.includes(candidate)) keys.push(candidate);
	}
	return Object.freeze({
		relativePath,
		scope,
		keys: Object.freeze(keys),
	});
}

export function parseWaspWebAppMeta(
	value: unknown,
): { readonly framework: "wasp"; readonly root: string } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const meta = value as { framework?: unknown; root?: unknown };
	if (meta.framework !== "wasp") return undefined;
	if (typeof meta.root !== "string" || meta.root.trim().length === 0) {
		return undefined;
	}
	const relative = meta.root.trim();
	if (
		!RELATIVE_PATH.test(relative) ||
		relative.split("/").some((segment) => DOTS_ONLY_SEGMENT.test(segment))
	) {
		return undefined;
	}
	return Object.freeze({ framework: "wasp", root: relative });
}

export function parseWaspWebAppAnnotation(
	value: unknown,
): WaspWebAppAnnotation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const annotation = value as {
		provider?: unknown;
		option?: unknown;
		config?: unknown;
	};
	if (annotation.provider !== "hobo" || annotation.option !== "webapp") {
		return undefined;
	}
	const config = annotation.config;
	if (typeof config !== "object" || config === null) return undefined;
	if ((config as { framework?: unknown }).framework !== "wasp")
		return undefined;
	const meta = parseWaspWebAppMeta(config);
	if (meta === undefined) {
		throw new WaspInputRejectedError(
			"annotation.config.root",
			"a wasp webapp annotation must carry a repo-relative root",
		);
	}
	return Object.freeze({
		provider: "hobo",
		option: "webapp",
		framework: "wasp",
		root: meta.root,
	});
}
