import { createHash } from "node:crypto";
import { join } from "node:path";
import { build } from "esbuild";

export type ControllerReleaseEntry = Readonly<{
	artifactName: string;
	entry: string;
}>;

export const CONTROLLER_RELEASE_ENTRIES: readonly ControllerReleaseEntry[] =
	Object.freeze([
		{
			artifactName: "hobo-ci-worker-release",
			entry: "scripts/isolated-worker-daemon-main.mts",
		},
	]);

export type ControllerRelease = Readonly<{
	artifactName: string;
	digest: string;
	fileName: string;
	bytes: Uint8Array;
}>;

export async function buildControllerReleases(
	input: Readonly<{
		packageRoot: string;
		entries: readonly ControllerReleaseEntry[];
	}>,
): Promise<readonly ControllerRelease[]> {
	const releases: ControllerRelease[] = [];
	for (const { artifactName, entry } of input.entries) {
		const result = await build({
			absWorkingDir: input.packageRoot,
			entryPoints: [join(input.packageRoot, entry)],
			bundle: true,
			platform: "node",
			target: "node22",
			format: "esm",
			write: false,
			legalComments: "none",
			logLevel: "silent",
			define: { "process.env.HOBO_CI_RELEASE_BUILD": '"1"' },
			banner: {
				js: 'import { createRequire as __hoboCreateRequire } from "node:module"; const require = __hoboCreateRequire(import.meta.url);',
			},
		});
		const output = result.outputFiles[0];
		if (!output) throw new Error(`esbuild produced nothing for ${entry}`);
		const bytes = output.contents;
		const hex = createHash("sha256").update(bytes).digest("hex");
		releases.push(
			Object.freeze({
				artifactName,
				digest: `sha256:${hex}`,
				fileName: `${hex}.mjs`,
				bytes,
			}),
		);
	}
	return Object.freeze(releases);
}

export type ControllerReleaseIndexEntry = Readonly<{
	version: string;
	url: string;
	digest: string;
	size: number;
	mediaType: string;
}>;

export type ControllerReleaseIndex = Readonly<{
	items: readonly ControllerReleaseIndexEntry[];
}>;

export function controllerReleaseIndex(
	release: ControllerRelease,
	options: Readonly<{
		version: string;
		baseUrl?: string | undefined;
		existing?: readonly ControllerReleaseIndexEntry[] | undefined;
	}>,
): ControllerReleaseIndex {
	const base = options.baseUrl
		? options.baseUrl.endsWith("/")
			? options.baseUrl
			: `${options.baseUrl}/`
		: "";
	return {
		items: [
			...(options.existing ?? []).filter(
				(entry) => entry.digest !== release.digest,
			),
			{
				version: options.version,
				url: `${base}${release.fileName}`,
				digest: release.digest,
				size: release.bytes.byteLength,
				mediaType: "text/javascript",
			},
		],
	};
}
