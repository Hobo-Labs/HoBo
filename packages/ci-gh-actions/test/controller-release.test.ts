// Controller releases, built and run for real: the box worker daemon and
// the local runner bundled into single-file `.mjs` releases
// (`scripts/controller-release.mts`), one staged by its digest in a host's
// data directory, and the supervisor starting it with `node` and nothing
// beside it until it advertises the digest it was started at. Offline: the
// local runner has no repository configured, so it registers nothing; its
// mesh node still writes its advert for the host's CD agent.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildControllerReleases,
	CONTROLLER_RELEASE_ENTRIES,
	controllerReleaseIndex,
} from "../scripts/controller-release.mts";
import {
	controllerReleasePath,
	createControllerProcessPort,
	createControllerSupervisor,
	nodeControllerLauncher,
	releaseEntryPath,
	stageControllerRelease,
} from "../src/runner-controller-process.js";
import { workerHostFiles } from "../src/runner-host-worker-jobs.js";

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
			"hobo-ci-local-runner-release",
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

	it("the supervisor runs the local runner release staged by digest, and it advertises that digest", async () => {
		const [release] = await buildControllerReleases({
			packageRoot: PACKAGE,
			entries: CONTROLLER_RELEASE_ENTRIES.filter(
				(entry) => entry.artifactName === "hobo-ci-local-runner-release",
			),
		});
		if (!release) throw new Error("no local runner release");
		const state = await mkdtemp(join(tmpdir(), "controller-release-"));
		dirs.push(state);
		// The local runner's state directory is the host's data directory.
		const files = workerHostFiles(join(state, "worker.sqlite"));
		const digest = await stageControllerRelease(files, release.bytes);
		expect(digest).toBe(release.digest);
		expect(controllerReleasePath(files, digest)).toBe(
			join(files.controllerReleases, release.fileName),
		);
		const port = createControllerProcessPort({
			files,
			fetchRelease: async () => {
				throw new Error("already staged");
			},
		});
		const supervisor = createControllerSupervisor({
			files,
			launch: nodeControllerLauncher({
				args: ["daemon"],
				env: {
					PATH: process.env.PATH,
					HOME: state,
					NODE_NO_WARNINGS: "1",
					// A release has no checkout to find its state from.
					HOBO_CI_LOCAL_STATE_DIRECTORY: state,
				},
				cwd: state,
			}),
			stopTimeoutMs: 30_000,
		});
		try {
			await port.run(digest);
			await supervisor.tick();
			expect(await port.status()).toMatchObject({
				state: "running",
				digest,
			});
			let advert: { controllerDigest?: string } | undefined;
			for (let i = 0; i < 300 && advert?.controllerDigest === undefined; i++) {
				if (existsSync(files.meshAdvert))
					try {
						advert = JSON.parse(readFileSync(files.meshAdvert, "utf8"));
					} catch {
						// Written atomically; a read never sees half, but retry anyway.
					}
				await pause(50);
			}
			expect(advert?.controllerDigest).toBe(digest);
			// Still the one it started: it has not exited.
			await supervisor.tick();
			expect((await port.status())?.state).toBe("running");
		} finally {
			await supervisor.shutdown();
		}
		expect((await port.status())?.state).toBe("stopped");
		expect(supervisor.childPid()).toBeUndefined();
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
