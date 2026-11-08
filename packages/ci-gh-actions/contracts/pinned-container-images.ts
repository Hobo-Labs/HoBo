import catalog from "./pinned-container-images.json" with { type: "json" };

export type PinnedContainerImages = typeof catalog;

/** Digest-pinned images shared by compose, Testcontainers, and CI docs. */
export const pinnedContainerImages: PinnedContainerImages = catalog;

export function parsePinnedImage(ref: string) {
	const at = ref.lastIndexOf("@sha256:");
	if (at === -1) {
		throw new Error(`expected digest-pinned image ref, got ${ref}`);
	}
	return {
		repository: ref.slice(0, at),
		digest: ref.slice(at + 1),
	} satisfies { repository: string; digest: string };
}
