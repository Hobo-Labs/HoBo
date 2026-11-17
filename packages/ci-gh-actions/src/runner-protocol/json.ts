/**
 * Reading JSON the way the Actions runner does. The runner reads its own
 * files and the service's answers with Newtonsoft.Json, which matches property
 * names without regard to case, and its configuration dictionaries are
 * case-insensitive (`CredentialData.Data` in `Runner.Common/CredentialData.cs`
 * uses `StringComparer.OrdinalIgnoreCase`). So every object key is lower-cased
 * here before a schema reads it.
 *
 * Two keys that differ only by case are read one of two ways. A configuration
 * the relay is handed (`parseJitConfig`) is refused outright: the runner would
 * read one of them and silently drop the other, and which one is not
 * something to guess about a credential. What the service sends back (a job
 * message, a token, an offer) keeps the last of them, as Newtonsoft does when
 * it sets a property twice: those messages carry dictionaries such as
 * `variables` where the runner keeps both keys, and refusing them would leave
 * an acquired job hanging.
 */
import type { z } from "zod";

/** JSON that could not be read. The message names what was wrong, never a value. */
export class ProtocolJsonRejection extends Error {
	override readonly name = "ProtocolJsonRejection";
}

/** What to do with two keys that differ only by case: refuse the JSON, or keep the last. */
export type CaseCollisions = "refuse" | "keep-last";

function lowerKeys(collisions: CaseCollisions) {
	return function lower(
		this: void,
		_key: string,
		value: ReturnType<typeof JSON.parse>,
	) {
		if (!(value instanceof Object) || Array.isArray(value)) return value;
		const lowered = new Map<string, ReturnType<typeof JSON.parse>>();
		for (const [key, entry] of Object.entries(value)) {
			const name = key.toLowerCase();
			if (collisions === "refuse" && lowered.has(name))
				throw new ProtocolJsonRejection(
					`two keys differ only by case ("${name}")`,
				);
			lowered.set(name, entry);
		}
		return Object.fromEntries(lowered);
	};
}

/**
 * Parse `text` as JSON with lower-cased keys and read it with `schema`. Throws
 * a `ProtocolJsonRejection` saying which of `what` was wrong. Two keys that
 * differ only by case keep the last unless `collisions` is `refuse`.
 */
export function readProtocolJson<T>(
	text: string,
	schema: z.ZodType<T>,
	what: string,
	collisions: CaseCollisions = "keep-last",
): T {
	let parsed: ReturnType<typeof JSON.parse>;
	try {
		parsed = JSON.parse(text, lowerKeys(collisions));
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
