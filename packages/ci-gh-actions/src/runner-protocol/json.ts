/**
 * Reading JSON the way the Actions runner does. The runner reads its own
 * files and the service's answers with Newtonsoft.Json, which matches property
 * names without regard to case, and its configuration dictionaries are
 * case-insensitive (`CredentialData.Data` in `Runner.Common/CredentialData.cs`
 * uses `StringComparer.OrdinalIgnoreCase`). So every object key is lower-cased
 * here before a schema reads it, and an object holding two keys that differ
 * only by case is refused: the runner would read one of them and silently drop
 * the other, and which one is not something to guess.
 */
import type { z } from "zod";

/** JSON that could not be read. The message names what was wrong, never a value. */
export class ProtocolJsonRejection extends Error {
	override readonly name = "ProtocolJsonRejection";
}

function lowerKeys(
	this: void,
	_key: string,
	value: ReturnType<typeof JSON.parse>,
) {
	if (!(value instanceof Object) || Array.isArray(value)) return value;
	const lowered = new Map<string, ReturnType<typeof JSON.parse>>();
	for (const [key, entry] of Object.entries(value)) {
		const name = key.toLowerCase();
		if (lowered.has(name))
			throw new ProtocolJsonRejection(
				`two keys differ only by case ("${name}")`,
			);
		lowered.set(name, entry);
	}
	return Object.fromEntries(lowered);
}

/**
 * Parse `text` as JSON with lower-cased keys and read it with `schema`. Throws
 * a `ProtocolJsonRejection` saying which of `what` was wrong.
 */
export function readProtocolJson<T>(
	text: string,
	schema: z.ZodType<T>,
	what: string,
): T {
	let parsed: ReturnType<typeof JSON.parse>;
	try {
		parsed = JSON.parse(text, lowerKeys);
	} catch (error) {
		if (error instanceof ProtocolJsonRejection)
			throw new ProtocolJsonRejection(`${what}: ${error.message}`);
		throw new ProtocolJsonRejection(`${what} is not JSON`);
	}
	const result = schema.safeParse(parsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const at =
			issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
		throw new ProtocolJsonRejection(
			`${what} has the wrong shape${at}: ${issue?.message ?? "unreadable"}`,
		);
	}
	return result.data;
}
