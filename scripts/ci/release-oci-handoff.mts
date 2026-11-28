import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertReleaseImageMatchesBuild } from "../lib/release-ghcr-digest.mts";
import {
	exportReleaseOciLayout,
	type ReleaseOciLayout,
	readOciLayout,
	releaseImageCandidateRef,
} from "./build-release-oci-image.mts";

export function verifyReleaseOciHandoff(
	dir: string,
	expected: { imageId: string; revision: string; version: string },
): ReleaseOciLayout {
	const layout = readOciLayout(dir);
	const paths = new Map(layout.blobs.map((blob) => [blob.digest, blob.path]));
	const visit = (digest: string): number => {
		const path = paths.get(digest);
		if (!path)
			throw new Error(`OCI handoff is missing verified blob ${digest}`);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		if (Array.isArray(doc.manifests)) {
			const count = doc.manifests.reduce(
				(
					sum: number,
					entry: { digest: string; annotations?: Record<string, string> },
				) =>
					entry.annotations?.["vnd.docker.reference.type"] ===
					"attestation-manifest"
						? sum
						: sum + visit(entry.digest),
				0,
			);
			if (count === 0)
				throw new Error("OCI handoff index has no runnable images");
			return count;
		}
		const configPath = paths.get(doc.config?.digest);
		if (!configPath)
			throw new Error("OCI handoff manifest has no verified config");
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		const labels = config.config?.Labels;
		assertReleaseImageMatchesBuild({
			imageId: expected.imageId,
			tag: expected.imageId,
			digestRef: layout.digest,
			revision: expected.revision,
			releaseVersion: expected.version,
			labels,
		});
		if (labels?.["org.opencontainers.image.version"] !== expected.version)
			throw new Error("OCI handoff version is missing or does not match");
		return 1;
	};
	visit(layout.digest);
	return layout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [imageId, dir] = process.argv.slice(2);
	if (!imageId || !dir)
		throw new Error("usage: release-oci-handoff.mts <image-id> <layout-dir>");
	exportReleaseOciLayout(releaseImageCandidateRef(imageId), dir);
}
