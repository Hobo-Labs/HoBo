import type { NavGroup } from "../nav";

export type DocsSearchEntry = {
	readonly slug: string;
	readonly label: string;
	readonly group: string;
	readonly haystack: string;
};

export function docsSearchEntries(
	groups: readonly NavGroup[],
): readonly DocsSearchEntry[] {
	const seen = new Set<string>();
	const entries: DocsSearchEntry[] = [];
	for (const group of groups) {
		for (const item of group.items) {
			if (seen.has(item.slug)) continue;
			seen.add(item.slug);
			entries.push({
				slug: item.slug,
				label: item.label,
				group: group.label,
				haystack: `${item.label} ${group.label} ${item.slug}`.toLowerCase(),
			});
		}
	}
	return entries;
}
