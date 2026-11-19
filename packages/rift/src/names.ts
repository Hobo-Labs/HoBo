
declare const brand: unique symbol;

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

export const MAX_NAME_LENGTH = 64;

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
		return {
			ok: false,
			reason:
				"name must start with a letter or digit and contain only letters, digits, '.', '_' or '-'",
		};
	}
	return { ok: true, value: name as WorkspaceName };
}
