import type { z } from "zod";

export class ProtocolJsonRejection extends Error {
	override readonly name = "ProtocolJsonRejection";
}

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
				throw new ProtocolJsonRejection("two keys differ only by case");
			lowered.set(name, entry);
		}
		return Object.fromEntries(lowered);
	};
}

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
	if (!result.success)
		throw new ProtocolJsonRejection(`${what} has the wrong shape`);
	return result.data;
}
