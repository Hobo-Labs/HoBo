/**
 * One tree for every configuration format the deployment assets use (NATS
 * server configuration, Compose, Kubernetes): scalars as text, lists and
 * maps. The assertions in assets.test.ts walk it by key.
 */

// domain-view: a parsed configuration file; the formats have no schema of their own here.
export type Tree =
	| Readonly<{ kind: "scalar"; text: string }>
	| Readonly<{ kind: "list"; items: readonly Tree[] }>
	| Readonly<{ kind: "map"; entries: ReadonlyMap<string, Tree> }>;

export function scalar(text: string): Tree {
	return { kind: "scalar", text };
}

/** The child at `path`, or undefined when any step is missing. */
export function at(
	tree: Tree | undefined,
	...path: string[]
): Tree | undefined {
	let node = tree;
	for (const key of path) {
		if (node?.kind !== "map") return undefined;
		node = node.entries.get(key);
	}
	return node;
}

/** The scalar text at `path`, or undefined. */
export function text(
	tree: Tree | undefined,
	...path: string[]
): string | undefined {
	const node = at(tree, ...path);
	return node?.kind === "scalar" ? node.text : undefined;
}

/** The list items at `path` (a scalar counts as a list of one); empty when missing. */
export function items(
	tree: Tree | undefined,
	...path: string[]
): readonly Tree[] {
	const node = at(tree, ...path);
	if (node === undefined) return [];
	if (node.kind === "list") return node.items;
	return node.kind === "scalar" ? [node] : [];
}

/** The scalar texts of the list at `path`. */
export function texts(tree: Tree | undefined, ...path: string[]): string[] {
	return items(tree, ...path).flatMap((item) =>
		item.kind === "scalar" ? [item.text] : [],
	);
}

/** The entries of the map at `path`; empty when missing. */
export function entries(
	tree: Tree | undefined,
	...path: string[]
): [string, Tree][] {
	const node = at(tree, ...path);
	return node?.kind === "map" ? [...node.entries] : [];
}

export function isMap(tree: Tree | undefined): boolean {
	return tree?.kind === "map";
}

// domain-view: the plain value a YAML library answers for one document.
export type Plain =
	| string
	| number
	| boolean
	| null
	| Plain[]
	| { [key: string]: Plain };

/** A YAML document's plain value as a tree. */
export function fromPlain(value: Plain): Tree {
	if (value === null) return scalar("");
	if (Array.isArray(value))
		return { kind: "list", items: value.map((item) => fromPlain(item)) };
	if (value instanceof Object)
		return {
			kind: "map",
			entries: new Map(
				Object.entries(value).map(([key, child]) => [key, fromPlain(child)]),
			),
		};
	return scalar(String(value));
}
