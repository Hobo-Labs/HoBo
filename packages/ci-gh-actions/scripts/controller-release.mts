/**
 * Bundle controller entries into single-file releases (`build-controller-release.mts`).
 *
 * Every workspace package and npm dependency is inlined; only Node built-ins
 * stay imports, so a release runs as `node <hex>.mjs` from
 * `controller-releases/` with nothing beside it. `HOBO_CI_RELEASE_BUILD` is
 * defined as `"1"`, which `releaseEntryPath` (`src/runner-controller-process.ts`)
 * reads: in a release, a path an entry would otherwise derive from its own
 * location must come from the environment.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { build } from "esbuild";

/** One entry a release is built from, relative to the package root. */
export type ControllerReleaseEntry = Readonly<{
	/** The Freight artifact name the release is published under. */
	artifactName: string;
	entry: string;
}>;

/** The controllers a host can run as a supervised process. */
export const CONTROLLER_RELEASE_ENTRIES: readonly ControllerReleaseEntry[] =
	Object.freeze([
		{
			artifactName: "hobo-ci-worker-release",
			entry: "scripts/isolated-worker-daemon-main.mts",
		},
		{
			artifactName: "hobo-ci-local-runner-release",
			entry: "scripts/local-runner.ts",
		},
	]);

export type ControllerRelease = Readonly<{
	artifactName: string;
	/** `sha256:<hex>` of the bytes: the release's identity. */
	digest: string;
	/** `<hex>.mjs`, as the supervisor stages it. */
	fileName: string;
	bytes: Uint8Array;
}>;

/** Bundle each entry; the same sources give the same bytes. */
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
			// Bundled CommonJS dependencies call require(); give them one.
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

/** An `index.<artifact>.json` document. */
export type ControllerReleaseIndex = Readonly<{
	items: readonly ControllerReleaseIndexEntry[];
}>;

/**
 * One release's index (`index.<artifactName>.json`), the list an HTTP_INDEX
 * Freight subscription reads: `existing` entries kept, this release added
 * under `version` (an entry with the same digest is replaced), `url` under
 * `baseUrl` (an `https://` base) and `digest` the bytes' sha256. Without a
 * base URL an entry names the file alone.
 */
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
