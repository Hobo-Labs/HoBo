// Typed parse failure shared by every SDK factory. Declarations follow parse,
// don't validate: invalid authoring input never yields a declaration object —
// the factory throws before anything is frozen or returned.
export class SdkDeclarationError extends TypeError {
	readonly declaration: string;
	readonly path: string;

	constructor(declaration: string, path: string, message: string) {
		super(`${declaration}.${path}: ${message}`);
		this.name = "SdkDeclarationError";
		this.declaration = declaration;
		this.path = path;
	}
}

export function requireNonEmptyString(
	declaration: string,
	path: string,
	value: unknown,
): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new SdkDeclarationError(
			declaration,
			path,
			"must be a non-empty string",
		);
	}
	return value;
}

export function requireRecord(
	declaration: string,
	path: string,
	value: unknown,
): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new SdkDeclarationError(declaration, path, "must be an object");
	}
	return value as Record<string, unknown>;
}

// Recursively freezes a declaration so the returned contract object is
// immutable evidence of exactly what was authored.
export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	for (const key of Object.getOwnPropertyNames(value)) {
		const child = (value as Record<string, unknown>)[key];
		if (
			child !== null &&
			typeof child === "object" &&
			!Object.isFrozen(child)
		) {
			deepFreeze(child);
		}
	}
	return Object.freeze(value);
}
