export type WorkerImage = Readonly<{
	id: string;
	tag: string;
	created: string;
	inUse: boolean;
}>;

const WORKER_VERSION_TAG = /^hobo-ci-worker:(v[0-9a-f]{12})$/u;
const RELEASE_CANDIDATE_TAG = /^[^:/]+:candidate$/u;
const GHCR_HOBO_RELEASE =
	/^ghcr\.io\/hobo-labs\/hobo\/(hobo(?:-[a-z-]+)?):[^:]+$/u;

/**
 * A release image this young may still be mid-flow: built, tagged for GHCR,
 * pushed and attested by separate steps and jobs (20-minute job rule, finding 121).
 */
export const RELEASE_IMAGE_GC_GRACE_MS = 60 * 60_000;

/**
 * Superseded GHCR-tagged release images, oldest per image name first to go.
 * Never a `:candidate` tag (the name the release flow reads), never an image a
 * container uses or a candidate still names, and never one inside the grace.
 */
export function selectReleaseImageTagsForDeletion(
	images: readonly WorkerImage[],
	options: Readonly<{ nowMs?: number; graceMs?: number }> = {},
): readonly string[] {
	const nowMs = options.nowMs ?? Date.now();
	const graceMs = options.graceMs ?? RELEASE_IMAGE_GC_GRACE_MS;
	const heldIds = new Set(
		images
			.filter((image) => image.inUse || RELEASE_CANDIDATE_TAG.test(image.tag))
			.map((image) => image.id),
	);
	const groups = new Map<string, WorkerImage[]>();
	for (const image of images) {
		const stem = GHCR_HOBO_RELEASE.exec(image.tag)?.[1];
		if (stem === undefined || image.inUse || heldIds.has(image.id)) continue;
		const group = groups.get(stem) ?? [];
		group.push(image);
		groups.set(stem, group);
	}
	const stale: string[] = [];
	for (const group of groups.values()) {
		const sorted = [...group].sort(newestFirst);
		for (const image of sorted.slice(1)) {
			const createdMs = Date.parse(image.created);
			// An unreadable age is treated as young.
			if (!Number.isFinite(createdMs) || nowMs - createdMs < graceMs) continue;
			stale.push(image.tag);
		}
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

/** Map `hobo-ci-deps:local` keep hint to a keyed tag when the label is present. */
export function depsGcKeepTag(
	requested: string | undefined,
	localDepsKey: string | undefined,
): string | undefined {
	if (requested === undefined) return undefined;
	if (
		requested.startsWith("hobo-ci-deps:") &&
		requested !== "hobo-ci-deps:local"
	)
		return requested;
	if (requested === "hobo-ci-deps:local" && localDepsKey)
		return `hobo-ci-deps:${localDepsKey}`;
	return undefined;
}

export function selectWorkerImagesForDeletion(
	images: readonly WorkerImage[],
	currentDepsTag?: string,
	options: Readonly<{ nowMs?: number }> = {},
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
		...selectReleaseImageTagsForDeletion(images, options),
	];
}
