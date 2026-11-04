export type WorkerImage = Readonly<{
	tag: string;
	created: string;
	inUse: boolean;
}>;

export function selectWorkerImagesForDeletion(
	images: readonly WorkerImage[],
): readonly string[] {
	const staleFetchImages = images
		.filter(
			(image) => image.tag.startsWith("hobo-ci-deps-fetch:") && !image.inUse,
		)
		.map((image) => image.tag);
	const depsImages = images
		.filter(
			(image) =>
				image.tag.startsWith("hobo-ci-deps:") &&
				image.tag !== "hobo-ci-deps:local" &&
				!image.inUse,
		)
		.sort(
			(a, b) =>
				Date.parse(b.created) - Date.parse(a.created) ||
				a.tag.localeCompare(b.tag),
		);
	return [
		...staleFetchImages,
		...depsImages.slice(2).map((image) => image.tag),
	];
}
