function missing(what: string | undefined): Error {
	return new Error(
		what ? `missing required value: ${what}` : "missing required value",
	);
}

export function must<T>(value: T | undefined | null, what?: string): T {
	if (value === undefined || value === null) {
		throw missing(what);
	}
	return value;
}

export type Indexed<T> = {
	readonly length: number;
	at(index: number): T | undefined;
};

export function at<T>(items: Indexed<T>, index: number, what?: string): T {
	const value = items.at(index);
	if (value === undefined) {
		throw missing(`${what ?? "collection"}[${index}] (length ${items.length})`);
	}
	return value;
}

export function first<T>(items: Indexed<T>, what?: string): T {
	return at(items, 0, what);
}

export function last<T>(items: Indexed<T>, what?: string): T {
	return at(items, -1, what);
}

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
