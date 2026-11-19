import type { BindleEdge } from "@hobo/bindles";
import type { ServableEntrypoint } from "./servable-entrypoints.js";

export function orderLocalComponents(
	entries: readonly ServableEntrypoint[],
	edges: readonly BindleEdge[],
): ServableEntrypoint[] {
	const pending = new Set(entries.map((entry) => entry.name));
	const dependencies = new Map(
		entries.map((entry) => [entry.name, new Set<string>()]),
	);
	for (const edge of edges) {
		if (pending.has(edge.from) && pending.has(edge.to)) {
			dependencies.get(edge.from)?.add(edge.to);
		}
	}
	const ordered: ServableEntrypoint[] = [];
	while (pending.size > 0) {
		const remaining = pending.size;
		for (const entry of entries) {
			if (!pending.has(entry.name)) continue;
			const required = dependencies.get(entry.name);
			if (required && [...required].some((name) => pending.has(name))) continue;
			pending.delete(entry.name);
			ordered.push(entry);
		}
		if (remaining === pending.size) {
			throw new TypeError(
				`local component dependency cycle: ${[...pending].sort().join(", ")}`,
			);
		}
	}
	return ordered;
}
