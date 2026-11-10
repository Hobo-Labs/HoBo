export type WorkerImage = Readonly<{
	id: string;
	tag: string;
	created: string;
	inUse: boolean;
}>;

const WORKER_VERSION_TAG = /^hobo-ci-worker:(v[0-9a-f]{12})$/u;
const RELEASE_CANDIDATE_TAG = /^([^:/]+):candidate$/u;
const GHCR_HOBO_RELEASE =
	/^ghcr\.io\/hobo-labs\/hobo\/(hobo(?:-[a-z-]+)?):[^:]+$/u;

function releaseImageStem(tag: string): string | undefined {
	const candidate = RELEASE_CANDIDATE_TAG.exec(tag);
	if (candidate) return candidate[1];
	const ghcr = GHCR_HOBO_RELEASE.exec(tag);
	if (ghcr) return ghcr[1];
	return undefined;
}

export function selectReleaseImageTagsForDeletion(
	images: readonly WorkerImage[],
): readonly string[] {
	const groups = new Map<string, WorkerImage[]>();
	for (const image of images) {
		const stem = releaseImageStem(image.tag);
		if (stem === undefined || image.inUse) continue;
		const group = groups.get(stem) ?? [];
		group.push(image);
		groups.set(stem, group);
	}
	const stale: string[] = [];
	for (const group of groups.values()) {
		const sorted = [...group].sort(newestFirst);
		for (const image of sorted.slice(1)) stale.push(image.tag);
	}
	return stale.sort((a, b) => a.localeCompare(b));
}

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
		...selectReleaseImageTagsForDeletion(images),
	];
}
