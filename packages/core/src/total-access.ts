/**
 * Total accessors for indexed and optional reads.
 *
 * eli5: `noUncheckedIndexedAccess` makes `list[0]` and `map.get(k)` return
 * `T | undefined`, which is correct — the compiler cannot know the index is in
 * range. The usual escape is `list[0]!`, which tells the compiler to be quiet
 * and, when the assumption is wrong, hands the rest of the program an
 * `undefined` that surfaces as a confusing failure somewhere else entirely.
 *
 * tldr: these do the same narrowing but fail *here*, naming what was missing.
 * Parse, don't validate — and don't lie to the type checker.
 */

/** eli5: one place to phrase "the thing that should have been here wasn't". */
function missing(what: string | undefined): Error {
	return new Error(
		what ? `missing required value: ${what}` : "missing required value",
	);
}

/**
 * Narrow `T | undefined | null` to `T`, throwing a named error when absent.
 *
 * `what` is optional and is for the caller's own vocabulary ("winning
 * candidate", "route53 hosted zone id"). Omit it when it would only transcribe
 * the expression — the throw site is already in the stack trace.
 */
export function must<T>(value: T | undefined | null, what?: string): T {
	if (value === undefined || value === null) {
		throw missing(what);
	}
	return value;
}

/**
 * Anything positionally indexable: arrays, strings, TypedArrays, Buffers.
 * Narrower than `readonly T[]` would allow, which wrongly excluded the last three.
 */
export type Indexed<T> = {
	readonly length: number;
	at(index: number): T | undefined;
};

/** Element at `index`, or a named error naming the collection and index. */
export function at<T>(items: Indexed<T>, index: number, what?: string): T {
	const value = items.at(index);
	if (value === undefined) {
		throw missing(`${what ?? "collection"}[${index}] (length ${items.length})`);
	}
	return value;
}

/** First element, or a named error. */
export function first<T>(items: Indexed<T>, what?: string): T {
	return at(items, 0, what);
}

/** Last element, or a named error. */
export function last<T>(items: Indexed<T>, what?: string): T {
	return at(items, -1, what);
}

/** Value for `key`, or a named error naming the map and key. */
export function mustGet<K, V>(
	map: ReadonlyMap<K, V>,
	key: K,
	what?: string,
): V {
	const value = map.get(key);
	if (value === undefined) {
		throw missing(`${what ?? "map"}[${String(key)}]`);
	}
	return value;
}
