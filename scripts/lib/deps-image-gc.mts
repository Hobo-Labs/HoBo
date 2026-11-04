export type DepsImage = Readonly<{
	tag: string;
	created: number;
	inUse: boolean;
}>;

const DEPS_PREFIX = "hobo-ci-deps:";
const FETCH_PREFIX = "hobo-ci-deps-fetch:";
const LOCAL_TAG = "hobo-ci-deps:local";

export function selectDepsImageTagsForDeletion(
	images: readonly DepsImage[],
	currentTag: string,
): string[] {
	const deps = images
		.filter((image) => image.tag.startsWith(DEPS_PREFIX))
		.sort((a, b) => b.created - a.created || a.tag.localeCompare(b.tag));
	const keep = new Set([currentTag]);
	for (const image of deps) {
		if (keep.size === 2) break;
		if (image.inUse || image.tag === LOCAL_TAG) continue;
		keep.add(image.tag);
	}

	return [
		...new Set(
			images
				.filter((image) => {
					if (
						image.inUse ||
						image.tag === LOCAL_TAG ||
						image.tag === currentTag
					)
						return false;
					if (image.tag.startsWith(FETCH_PREFIX)) return true;
					return image.tag.startsWith(DEPS_PREFIX) && !keep.has(image.tag);
				})
				.map((image) => image.tag),
		),
	].sort();
}
