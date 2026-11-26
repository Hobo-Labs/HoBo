/**
 * The one parser boundary of @hobo/wasp.
 *
 * Everything this package knows comes from someone else's application tree: a
 * root path handed to `waspApp()`, two `.env.*.example` files read off disk, an
 * annotation read back out of a Bindle definition. All of it crosses a parser
 * here and comes out as refined domain types — a `WaspAppRoot` that is already
 * known to be inside the repo, `WaspEnvKey`s that are already shouty snake
 * case, a `WaspEnvExampleFile` that holds keys and *no values at all*.
 *
 * That last one is the property worth stating twice. A `.env.example` is a
 * documentation file, but it sits beside the real `.env` and is routinely
 * copied from it. `parseWaspEnvExample` reads the left-hand side of each
 * assignment and discards the right-hand side unread, so there is no code path
 * on which a value from an app tree can reach a Bindle manifest.
 *
 * `data-models/wasp_app.proto` is the wire view of these shapes and
 * `data-models/wasp_app.cue` carries the invariants enforced below.
 */

import path from "node:path";

export type WaspEnvScope = "server" | "client" | "general";

export type WaspBindleKind = "container" | "bucket" | "external" | "env";

/** A dotenv key: shouty snake case, as both Wasp and dotenv require. */
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

// public-contract: callers branch on this stable parse-boundary error code.
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

/**
 * A path segment that is only dots — `.` or `..` (or `...`, which no filesystem
 * treats specially but nothing legitimate uses either).
 *
 * `RELATIVE_PATH` alone does not reject traversal, despite what this module's
 * error message says: `.` is inside `[A-Za-z0-9._-]`, so `..` is a perfectly
 * ordinary segment as far as that character class is concerned and
 * `../../etc` matched it. The check has to be on segment *shape*, not on the
 * characters available.
 *
 * That mattered because `waspApp(root)` deliberately parses with
 * `parseWaspRelativeRoot` alone — the marker it stamps travels into a manifest
 * long before anything resolves it against a repository, so this is the only
 * place a bad root can be caught before it becomes a plausible-looking
 * declaration somewhere else.
 */
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

/**
 * The shape half of an app root: repo-relative, forward-slashed, no traversal,
 * no leading slash. `waspApp(root)` uses this on its own, because the marker it
 * stamps travels into a manifest long before anyone resolves it against a repo.
 */
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

/**
 * Resolve a repo-relative app directory once, and keep both forms.
 *
 * The escape check is the reason this is a parser and not a helper: after it,
 * "inside the repo" is a fact about the value, so nothing that reads a file
 * under `absolute` has to re-derive it.
 */
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
	// Compare against `base + sep` as well as `base` itself: a sibling named
	// `repo-evil` starts with `repo` and is not inside it.
	if (absolute !== base && !absolute.startsWith(base + path.sep)) {
		throw new WaspInputRejectedError(
			"root",
			`waspApp root escapes the repo: ${relative}`,
		);
	}
	return Object.freeze({ relative, absolute });
}

/**
 * Reduce a `.env.*.example` file to the keys it declares.
 *
 * Values are never read. A line's key is everything left of the first `=`, and
 * the remainder is dropped without being looked at, so nothing downstream can
 * accidentally carry one.
 */
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
		// Wasp only exposes `REACT_APP_*` to the browser bundle; anything else
		// in the client file would never reach the client, so treating it as a
		// client key would be wrong about where it lives.
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

/**
 * Read a `{ framework, root }` marker off a Bindle binding.
 *
 * Bindle detects webApps structurally (`Symbol.for("hobo.webapp.meta")`), so
 * this is where a marker stamped by anything at all becomes a marker this
 * package will vouch for.
 */
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
	// Same traversal check as the stamping path. This is the *reading* side —
	// a marker that arrived from a manifest written by some other version of
	// this code, or by hand — so it cannot assume the stamping guard ran.
	if (
		!RELATIVE_PATH.test(relative) ||
		relative.split("/").some((segment) => DOTS_ONLY_SEGMENT.test(segment))
	) {
		return undefined;
	}
	return Object.freeze({ framework: "wasp", root: relative });
}

/**
 * Read the annotation back out of a Bindle definition. Returns `undefined` for
 * an annotation belonging to some other provider or framework — a definition
 * legitimately carries many — and throws only for one that claims to be a Wasp
 * webApp and is malformed.
 */
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
