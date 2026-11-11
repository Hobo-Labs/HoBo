export type WorkerImage = Readonly<{
	id: string;
	tag: string;
	created: string;
	inUse: boolean;
}>;

const WORKER_VERSION_TAG = /^hobo-ci-worker:(v[0-9a-f]{12})$/u;

function newestFirst(a: WorkerImage, b: WorkerImage): number {
	return (
		Date.parse(b.created) - Date.parse(a.created) || a.tag.localeCompare(b.tag)
	);
}

export function selectWorkerImageTagsForDeletion(
	images: readonly WorkerImage[],
	currentVersion?: string,
): readonly string[] {
	const localId = images.find(
		(image) => image.tag === "hobo-ci-worker:local",
	)?.id;
	const localVersion = images.find(
		(image) => image.id === localId && WORKER_VERSION_TAG.test(image.tag),
	)?.tag;
	const versioned = images
		.filter((image) => WORKER_VERSION_TAG.test(image.tag))
		.sort(newestFirst);
	const currentTag = currentVersion
		? `hobo-ci-worker:${currentVersion}`
		: (localVersion ?? versioned[0]?.tag);
	const previousTag = versioned.find((image) => image.tag !== currentTag)?.tag;
	return versioned
		.filter(
			(image) =>
				!image.inUse && image.tag !== currentTag && image.tag !== previousTag,
		)
		.map((image) => image.tag);
}

/** Map `hobo-ci-deps:local` keep hint to a keyed tag when the label is present. */
export function depsGcKeepTag(
	requested: string | undefined,
	localDepsKey: string | undefined,
): string | undefined {
	if (requested === undefined) return undefined;
	if (requested.startsWith("hobo-ci-deps:") && requested !== "hobo-ci-deps:local")
		return requested;
	if (requested === "hobo-ci-deps:local" && localDepsKey)
		return `hobo-ci-deps:${localDepsKey}`;
	return undefined;
}

export function selectWorkerImagesForDeletion(
	images: readonly WorkerImage[],
	currentDepsTag?: string,
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
		.sort(newestFirst);
	const retainedDepsTags = new Set(
		currentDepsTag === undefined ? [] : [currentDepsTag],
	);
	for (const image of depsImages) {
		if (retainedDepsTags.size === 2) break;
		retainedDepsTags.add(image.tag);
	}
	return [
		...staleFetchImages,
		...depsImages
			.filter((image) => !retainedDepsTags.has(image.tag))
			.map((image) => image.tag),
		...selectWorkerImageTagsForDeletion(images),
	];
}
