import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SdkArtifactManifest = {
	version: string;
	packages: { workspace: string; public: string; file: string }[];
};

export function orderedSdkTarballPaths(artifactsDir: string): string[] {
	const manifestPath = join(artifactsDir, "MANIFEST.json");
	if (!existsSync(manifestPath)) {
		throw new Error(
			`missing ${manifestPath}; extract SDK artifacts before overlay install`,
		);
	}
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	// SAFETY: stageSdkArtifactsDir writes MANIFEST.json from SdkArtifactManifest.
	const manifest = parsed as SdkArtifactManifest;
	const paths = manifest.packages.map((entry) =>
		join(artifactsDir, entry.file),
	);
	for (const path of paths) {
		if (!existsSync(path)) {
			throw new Error(`SDK tarball missing from artifacts dir: ${path}`);
		}
	}
	return paths;
}
