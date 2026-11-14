// Controller releases, built for real: the box worker daemon bundled into a
// single-file `.mjs` release (`scripts/controller-release.mts`), named by its
// digest. The local runner release is gone with the local runner.
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildControllerReleases,
	CONTROLLER_RELEASE_ENTRIES,
	controllerReleaseIndex,
} from "../scripts/controller-release.mts";
import { releaseEntryPath } from "../src/runner-controller-process.js";

const PACKAGE = join(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

describe("controller releases", { timeout: 120_000 }, () => {
	it("bundles each controller entry into one self-contained file, named by its digest", async () => {
		const releases = await buildControllerReleases({
			packageRoot: PACKAGE,
			entries: CONTROLLER_RELEASE_ENTRIES,
		});
		expect(releases.map((release) => release.artifactName)).toEqual([
			"hobo-ci-worker-release",
		]);
		for (const release of releases) {
			const hex = createHash("sha256").update(release.bytes).digest("hex");
			expect(release.digest).toBe(`sha256:${hex}`);
			expect(release.fileName).toBe(`${hex}.mjs`);
			const text = new TextDecoder().decode(release.bytes);
			// Nothing outside Node itself is imported: no workspace package,
			// no relative path, no npm dependency.
			const imports = [
				...text.matchAll(/^import[^"'\n]*["']([^"']+)["']/gmu),
			].map((match) => match[1] ?? "");
			expect(imports.filter((name) => !name.startsWith("node:"))).toEqual([]);
			// No bundled module's "run me directly" guard is live: only the
			// release's own entry runs (not the relay, ops CLI or bootstrap).
			expect(text).not.toMatch(
				/import\.meta\.url === pathToFileURL\d*\((?:entry\d*|process\.argv\[1\])\)\.href/u,
			);
		}
		// The release index an HTTP_INDEX Freight subscription reads.
		const worker = releases[0];
		if (!worker) throw new Error("no worker release");
		expect(
			controllerReleaseIndex(worker, {
				version: "release-20261113100000-v0123456789ab",
				baseUrl: "https://releases.hobo.test/hobo-ci",
			}).items,
		).toEqual([
			{
				version: "release-20261113100000-v0123456789ab",
				url: `https://releases.hobo.test/hobo-ci/${worker.fileName}`,
				digest: worker.digest,
				size: worker.bytes.byteLength,
				mediaType: "text/javascript",
			},
		]);
	});

	it("refuses to guess a path from a release file's place", () => {
		const input = { name: "HOBO_CI_DEPS_ROOT", fallback: () => "/checkout" };
		expect(() =>
			releaseEntryPath({ ...input, env: {}, release: true }),
		).toThrow(
			/^HOBO_CI_DEPS_ROOT must be set: this controller runs as a release/u,
		);
		expect(
			releaseEntryPath({
				...input,
				env: { HOBO_CI_DEPS_ROOT: "/srv/hobo" },
				release: true,
			}),
		).toBe("/srv/hobo");
		expect(releaseEntryPath({ ...input, env: {}, release: false })).toBe(
			"/checkout",
		);
	});
});
