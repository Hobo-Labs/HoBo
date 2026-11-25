/**
 * Parse, don't validate: a workspace name that has been through `parseWorkspaceName`
 * is a `WorkspaceName`, and only a `WorkspaceName` can be turned into a path.
 *
 * This is not decoration. The name is joined onto the workspaces directory, so
 * an unparsed string is a path-traversal primitive: `--name ../../etc` would
 * have placed a workspace outside the root, and `--name ..` would have made
 * `remove` delete the root's own bookkeeping. The branded type makes it a type
 * error to reach the filesystem without going through the check.
 */

declare const brand: unique symbol;

/** A name proven safe to use as a single path segment. */
export type WorkspaceName = string & { readonly [brand]: "WorkspaceName" };

export interface ParseFailure {
	readonly ok: false;
	readonly reason: string;
}
export interface ParseSuccess {
	readonly ok: true;
	readonly value: WorkspaceName;
}
export type ParseResult = ParseSuccess | ParseFailure;

/** Length cap keeps the derived paths inside typical PATH_MAX budgets. */
export const MAX_NAME_LENGTH = 64;

/**
 * Allowlist, not a denylist.
 *
 * The parsed name is spliced into shell commands as part of a path, so every
 * shell metacharacter matters — rejecting only path separators let
 * `--name 'ws$(touch INJECTED)x'` execute the substitution *in the source
 * tree*, before the workspace was even entered. Enumerating what is allowed is
 * the only version of this check that stays correct as call sites are added.
 */
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function parseWorkspaceName(raw: string): ParseResult {
	const name = raw.trim();
	if (name.length === 0) return { ok: false, reason: "name is empty" };
	if (name.length > MAX_NAME_LENGTH) {
		return {
			ok: false,
			reason: `name is longer than ${MAX_NAME_LENGTH} characters`,
		};
	}
	if (name === "." || name === "..") {
		return {
			ok: false,
			reason: `"${name}" is a directory reference, not a name`,
		};
	}
	if (!ALLOWED.test(name)) {
		// Covers path separators, NUL, every shell metacharacter, and a leading
		// dash (which anything we shell out to would read as a flag).
		return {
			ok: false,
			reason:
				"name must start with a letter or digit and contain only letters, digits, '.', '_' or '-'",
		};
	}
	// SAFETY: `return { ok: true, value: name as WorkspaceName };` is required at this I/O or test boundary.
	return { ok: true, value: name as WorkspaceName };
}
